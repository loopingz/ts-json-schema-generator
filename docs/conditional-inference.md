# Contributor Notes: Conditional Type Inference (toJSON / DTO patterns)

This document explains the internal algorithms that power the advanced conditional type inference paths recently added (and refactored) around patterns like:

```ts
T extends { toJSON(): infer U } ? U : ...
T extends { fromDto(param: infer U): any } ? U : ...
T extends (infer E)[] ? Jsonify<E>[] : ...
```

It is meant to help future contributors reason about maintenance, extend safely, and avoid re‑introducing duplication.

---

## High-Level Goals

1. Preserve _structural fidelity_ of inferred return / parameter types (avoid `any` fallbacks that erase members).
2. Keep logic **abstraction-neutral** (no alias name hardcoding, e.g. never special‑case `Jsonify`).
3. Provide stable recovery ("rescue") when TypeScript’s raw type view hides methods after intermediate transformations (e.g. narrowed generics, indexed access, or conditional decomposition).
4. Make behavior deterministic by ordering candidate raw types and short‑circuiting once a concrete, method‑bearing target is found.

---

## Core Actors

| Component                        | Responsibility                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConditionalTypeNodeParser`      | Detects conditional patterns, binds `infer` variables, reconstructs method return/parameter types, orchestrates rescues.                            |
| `TypeAliasNodeParser`            | Early binding optimizations + passes along original raw types for alias generic scenarios.                                                          |
| `TypeReferenceNodeParser`        | Fallback realization of naked type parameters into their enriched raw originals (prevents `UnknownType`).                                           |
| `buildMethodReturnNode` (helper) | Centralized reconstruction of a method's _return_ type into a stable `TypeNode` (explicit annotation preference → signature → synthesized literal). |

---

## Pattern Matrix

| Pattern                                                                   | What is inferred                    | Extraction Source                                |
| ------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| Return infer `{ m(): infer U }`                                           | Return type of `m`                  | `buildMethodReturnNode` result                   |
| Parameter infer `{ m(param: infer U): any }`                              | First parameter's instantiated type | Signature parameter symbol (custom logic)        |
| Array element `(infer E)[]` / `Array<infer E>` / `ReadonlyArray<infer E>` | Element raw type (enriched)         | Array element index type (with class enrichment) |

---

## Processing Pipeline (Annotated)

1. **Initial Raw Resolution**
    - Derive `rawCheckType` from `node.checkType`.
    - If the check type is a type parameter or indexed access, attempt to unwrap to a richer original raw from context.
2. **Array Infer Pre-Pass**
    - Detect `(infer E)[]` (supports `Array<>`, `ReadonlyArray<>`, parentheses).
    - Capture element raw, enrich with its class declaration (to keep methods like `toJSON`).
    - Store / promote in:
        - `context.originalTypes` / ordered list
        - `concreteRaw` (if infra present)
        - `_lastMethodElementRaw` (fallback safety net)
3. **Early True-Branch Shortcuts**
    - If extends-literal is a method pattern and check type is an array whose element already has that method, synthesize array of return type immediately (short-circuits heavy logic).
4. **Method Pattern Detection**
    - Scan `extendsType` if it is a `TypeLiteralNode` for:
        - Return infer: `m(): infer U`
        - Parameter infer: `m(param: infer U): any`
        - Preference: return infer wins if both appear (rare) to keep deterministic ordering.
    - Promote parameter infer to a unified handling path (but extract differently later).
5. **Parameterized (Generic) Branch Handling**
    - Resolve a _target raw_ candidate (ordered: concreteRaw → boundRaw → rawCheckType → rescues through ordered originals → map values → element fallback).
    - Confirm method presence (including class declaration scan if property enumeration misses it).
    - If found:
        - For parameter-infer: extract first parameter type (rebuilding object literal if mapping produced `any`).
        - For return-infer: call `buildMethodReturnNode`.
        - Bind inferred variable (if `infer U`).
6. **Array + Recursive Alias Substitution**
    - When handling patterns like `Jsonify<E>[]`, after binding `E`, substitute the infer reference with the synthesized literal to avoid losing structure on recursive alias expansion.
7. **Concrete (Non-parameter) Branch**
    - Similar logic but without generic parameter context; optionally leverages explicit method return AST for richer structure.
8. **Late Fallback Phase**
    - If earlier optimizations failed, attempt a final substitution of the method’s return (or element return for arrays) before default conditional assignability evaluation.
9. **Standard Conditional Narrowing**
    - If none of the specialized paths produce a result, fall back to assignability: evaluate trueType / falseType with narrowed check type and merge via `UnionType`.

---

## `buildMethodReturnNode` Strategy

Order of preference:

1. Explicit return annotation if it is structurally rich (Literal / Union / Intersection / Reference / Array).
2. Signature return type via `getCallSignatures()[0]`.
3. Synthetic literal: Enumerate properties of the return type and build an inline `TypeLiteralNode` (avoids losing members and reduces `any`).

This prevents duplication elsewhere and MUST be used for any future method return inference paths.

---

## Parameter-Infer vs Return-Infer

| Aspect           | Return-Infer                             | Parameter-Infer                                                                          |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Captured Symbol  | Method symbol → return                   | First parameter symbol                                                                   |
| Rebuild Fallback | Via helper                               | Custom logic (mirrors helper’s object literal rebuild)                                   |
| Binding Location | `extendsInferName` maps after resolution | Immediate return of resolved param type (future improvement: record mapping if required) |

Future Improvement: Map the inferred parameter type into `inferMap` (today we simply return it, satisfying emitted schema). Keep invariants: never overwrite existing binding.

---

## Fallback & Rescue Heuristics

Ordered candidate sources when a method appears “missing”:

1. Current target raw
2. `originalTypesInOrder` (recently pushed enriched raws first)
3. All values of `originalTypes` map
4. `_lastMethodElementRaw` (global + per-context stash from array infer phase)
5. Apparent type of each candidate

Stop at the first candidate exposing the method; never merge multiple.

### Why So Many Rescues?

TypeScript often presents narrowed or partial views (e.g. an indexed access or distributed conditional) where method symbols aren’t visible on the intermediate type. Rescues reattach the original enriched class type without relying on brittle alias names.

---

## Context Data Contract

| Field / API                        | Purpose                                             | Notes                                                   |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `pushOriginalType(name, raw)`      | Preserve richer raw types for generics              | Only prefer if richer (has methods) vs plain type param |
| `originalTypesInOrder` (array)     | Deterministic precedence for rescues                | New enriched raws unshifted (front)                     |
| `pushConcreteRaw` (optional infra) | Lock a stable concrete realization                  | Checked before other rescues                            |
| `_lastMethodElementRaw`            | Single-slot safety net for nested element inference | Avoids loss across nested conditionals                  |

---

## Modification Guidelines

1. **Add new method-centric inference?** Always route return reconstruction through `buildMethodReturnNode`.
2. **Extending parameter-infer logic?** Mirror return path structure but avoid re‑introducing duplicated property enumeration (consider extracting a `buildObjectLikeNode` utility if it generalizes).
3. **Touching rescue order?** Update this doc + add a regression test capturing the old vs new precedence.
4. **Introducing new infer shapes (e.g. union param spread)?** Implement detection as a _pure syntactic check_ on `extendsType`; avoid semantic alias name checks.
5. **Performance concerns?** All heavy rescues are inside guarded blocks and short‑circuit early. If adding loops across candidates, keep them small and cache symbol/property arrays when possible.
6. **Don’t log noisy debug** by default—use the existing `debugLog` (guards on `TS_JSG_DEBUG`).

---

## Testing Strategy

Key tests exercising these paths:

- `conditional-tojson-*` (return infer + array recursion + nested)
- `generic-from-dto-param-infer` (parameter infer, primitive + object param fidelity)
- `generic-true-hell-2` (stress: nested conditionals + mixed DTO + never param)

When modifying logic:

1. Run focused failing test(s) first (pattern-specific).
2. Run full suite (`npm test --silent`) to ensure no collateral regressions (356 tests currently).
3. If adding a new inference rule, add a minimal positive test + a negative control (where the rule must NOT trigger).

---

## Common Pitfalls & Anti-Patterns

| Pitfall                                              | Why It’s Bad                              | Remedy                                              |
| ---------------------------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| Copy/pasting method return reconstruction            | Divergence & missed fixes                 | Use `buildMethodReturnNode`                         |
| Hard-coding alias names (e.g. `Jsonify`)             | Breaks abstraction / future extensibility | Rely purely on syntactic shape + context binding    |
| Overwriting richer original raw with bare type param | Loses method symbols                      | Compare property/method richness before replacement |
| Returning `any` from synthesized method inference    | Erodes schema quality                     | Rebuild object literal from return type props       |
| Logging directly with `console.log`                  | Noise in consumer environments            | Use `debugLog` wrapper                              |

---

## Future Extension Ideas

- Generalize parameter infer extraction to multiple params (capture a tuple type when more than one `infer` appears).
- Memoize property enumeration for large method return types to reduce repeated walker cost.
- Introduce a lightweight abstraction describing a "CandidateRawProvider" chain (would simplify rescue ordering modifications).
- Formalize infer mapping for parameter infer (store under detected `extendsInferName` when pattern uses `infer`).

---

## Quick Reference (Cheat Sheet)

```
Detect patterns → Bind array element (if any) → Early array shortcut →
Resolve target raw (parameterized vs concrete) → Attempt method (return vs param infer) →
Substitute recursive alias element (if needed) → Late fallbacks → Standard conditional narrowing.
```

Keep this ordering to preserve existing test expectations.

---

_Last updated: 2025-10-21_
