import ts from "typescript";
import type { Context, NodeParser } from "../NodeParser.js";
import type { SubNodeParser } from "../SubNodeParser.js";
import { AliasType } from "../Type/AliasType.js";
import type { BaseType } from "../Type/BaseType.js";
import { NeverType } from "../Type/NeverType.js";
import type { ReferenceType } from "../Type/ReferenceType.js";
import { getKey } from "../Utils/nodeKey.js";
import { buildAliasDescriptor } from "./AliasDescriptor.js";
import { attemptBindMethodReturn } from "./MethodReturnExtractor.js";

// Internal debug logging helper (enable by setting TS_JSG_DEBUG=1 in environment)
const debugLog = (...args: any[]) => {
    try {
        if (process?.env?.TS_JSG_DEBUG) {
            // eslint-disable-next-line no-console
            console.log(...args);
        }
    } catch {
        /* ignore */
    }
};

export class TypeAliasNodeParser implements SubNodeParser {
    public constructor(
        protected typeChecker: ts.TypeChecker,
        protected childNodeParser: NodeParser,
    ) {}

    public supportsNode(node: ts.TypeAliasDeclaration): boolean {
        return node.kind === ts.SyntaxKind.TypeAliasDeclaration;
    }

    public createType(node: ts.TypeAliasDeclaration, context: Context, reference?: ReferenceType): BaseType {
        // Step 1 of refactor: build & cache a structural descriptor of the alias' conditional chain.
        // (Purely observational; doesn't change existing behaviour yet.)
        let descriptorBuilt = false;
        try {
            const desc = buildAliasDescriptor(node);
            descriptorBuilt = true;
            // After generic parameter raw binding (later in function) we'll attempt method return binding.
            // For early phases (before parameters processed) we only cache the descriptor.
        } catch {
            /* ignore descriptor build errors to avoid impacting existing flow */
        }
        if (node.typeParameters?.length) {
            for (let i = 0; i < node.typeParameters.length; i++) {
                const typeParam = node.typeParameters[i];
                const nameSymbol = this.typeChecker.getSymbolAtLocation(typeParam.name)!;
                context.pushParameter(nameSymbol.name);
                // Bind previously captured original raw type by index if available
                // Prefer explicit original type mapping (e.g., manually bound for alias param) then fall back to ordered list.
                let raw = context.getOriginalType(nameSymbol.name);
                // If a deterministic concreteRaw already exists for this parameter, prefer it immediately.
                try {
                    const existingConcrete: ts.Type | undefined = (context as any).getConcreteRaw?.(nameSymbol.name);
                    if (existingConcrete) {
                        // Only override if current raw is missing or a naked type parameter / indexed access without richer props
                        if (!raw || (raw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                            raw = existingConcrete;
                        }
                    }
                } catch {
                    /* ignore */
                }
                // Forced element raw fallback (added by ConditionalTypeNodeParser universal array infer)
                try {
                    // Global fallback (last known element raw) if still a naked type parameter
                    if (raw && (raw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                        try {
                            const globalForced: ts.Type | undefined = (globalThis as any).__lastMethodElementRaw;
                            if (globalForced) {
                                // Unconditionally promote; method presence checked elsewhere
                                raw = globalForced;
                                debugLog(
                                    "[debug alias promote] param",
                                    nameSymbol.name,
                                    "promoted from type param to lastMethodElementRaw=",
                                    this.typeChecker.typeToString(globalForced),
                                );
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                } catch {
                    /* ignore */
                }
                const indexCandidate = context.getOriginalTypeByIndex(i);
                try {
                    if (raw && (raw.flags & ts.TypeFlags.TypeParameter) !== 0 && indexCandidate) {
                        // If indexCandidate has at least one method (e.g., toJSON), prefer it
                        let indexHasMethod = false;
                        try {
                            const props = this.typeChecker.getPropertiesOfType(indexCandidate);
                            indexHasMethod = props.some((p) => {
                                try {
                                    const decl = p.valueDeclaration ?? p.declarations?.[0];
                                    if (!decl) return false;
                                    const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                    return (t.getCallSignatures()?.length || 0) > 0;
                                } catch {
                                    return false;
                                }
                            });
                        } catch {
                            /* ignore */
                        }
                        if (indexHasMethod) {
                            raw = indexCandidate;
                        }
                    } else if (!raw && indexCandidate) {
                        raw = indexCandidate;
                    }
                } catch {
                    /* ignore */
                }
                if (raw) {
                    // If raw is still a naked type parameter, attempt to find a better concrete candidate from ordered originals (method-bearing preferred)
                    try {
                        if ((raw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                            const ordered: ts.Type[] = (context as any).originalTypesInOrder || [];
                            for (const cand of ordered) {
                                if ((cand.flags & ts.TypeFlags.TypeParameter) !== 0) continue;
                                // Prefer a candidate that has at least one method (e.g., toJSON)
                                let hasAnyMethod = false;
                                try {
                                    const props = this.typeChecker.getPropertiesOfType(cand);
                                    hasAnyMethod = props.some((p) => {
                                        try {
                                            const decl = p.valueDeclaration ?? p.declarations?.[0];
                                            if (!decl) return false;
                                            const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                            return (t.getCallSignatures()?.length || 0) > 0;
                                        } catch {
                                            return false;
                                        }
                                    });
                                } catch {
                                    /* ignore */
                                }
                                if (hasAnyMethod) {
                                    raw = cand;
                                    break;
                                }
                            }
                        }
                    } catch {
                        /* ignore */
                    }
                }
                if (raw) {
                    const existingOriginal = context.getOriginalType(nameSymbol.name);
                    const isIndexed = (raw.flags & ts.TypeFlags.IndexedAccess) !== 0;
                    if (i === 0) {
                        debugLog(
                            "[debug alias binding] param",
                            nameSymbol.name,
                            "raw=",
                            this.typeChecker.typeToString(raw),
                        );
                        try {
                            const propsDbg = this.typeChecker.getPropertiesOfType(raw).map((p) => p.getName());
                            debugLog("[debug alias binding] props=", propsDbg);
                            debugLog(
                                "[debug alias binding flags]",
                                (raw as any).flags,
                                "isTypeParam",
                                ((raw as any).flags & ts.TypeFlags.TypeParameter) !== 0,
                            );
                        } catch {
                            /* ignore */
                        }
                    }
                    // If raw is a different type parameter (e.g., argument is E while alias param is T) and we have an original raw for that parameter, use it.
                    try {
                        if ((raw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                            const sym = (raw as any).symbol as ts.Symbol | undefined;
                            const tparamName = sym?.getName();
                            if (tparamName && tparamName !== nameSymbol.name) {
                                let alt = context.getOriginalType(tparamName);
                                if (!alt) {
                                    try {
                                        alt = (context as any).getConcreteRaw?.(tparamName);
                                    } catch {
                                        /* ignore */
                                    }
                                }
                                // ConcreteRaw for alternate parameter
                                if (!alt) {
                                    try {
                                        alt = (context as any).getConcreteRaw?.(tparamName);
                                    } catch {
                                        /* ignore */
                                    }
                                }
                                // Fallback: if alt not found, try _lastMethodElementRaw stored in context (generic last element with method scenario)
                                if (!alt) {
                                    try {
                                        const fallback = (context as any)._lastMethodElementRaw as ts.Type | undefined;
                                        if (fallback) {
                                            // Ensure it actually has a method (any) to be considered richer
                                            let hasMethod = false;
                                            try {
                                                const props = this.typeChecker.getPropertiesOfType(fallback);
                                                hasMethod = props.some((p) => {
                                                    try {
                                                        const decl = p.valueDeclaration ?? p.declarations?.[0];
                                                        if (!decl) return false;
                                                        const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                                        return (t.getCallSignatures()?.length || 0) > 0;
                                                    } catch {
                                                        return false;
                                                    }
                                                });
                                            } catch {
                                                /* ignore */
                                            }
                                            if (hasMethod) alt = fallback;
                                        }
                                    } catch {
                                        /* ignore */
                                    }
                                }
                                if (alt) {
                                    raw = alt;
                                }
                                // Last resort: if still naked type parameter, prefer concreteRaw for current alias param if richer
                                if ((raw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                                    try {
                                        const selfConcrete: ts.Type | undefined = (context as any).getConcreteRaw?.(
                                            nameSymbol.name,
                                        );
                                        if (selfConcrete && selfConcrete !== raw) {
                                            const selfConcreteHasMethod = this.typeChecker
                                                .getPropertiesOfType(selfConcrete)
                                                .some((p) => {
                                                    try {
                                                        const decl = p.valueDeclaration ?? p.declarations?.[0];
                                                        if (!decl) return false;
                                                        const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                                        return (t.getCallSignatures()?.length || 0) > 0;
                                                    } catch {
                                                        return false;
                                                    }
                                                });
                                            if (selfConcreteHasMethod) {
                                                raw = selfConcrete;
                                            }
                                        }
                                    } catch {
                                        /* ignore */
                                    }
                                }
                            }
                        }
                    } catch {
                        /* ignore */
                    }
                    // Enrichment: if raw is array and its element has callable methods, prefer element raw
                    try {
                        const elem = this.typeChecker.getIndexTypeOfType(raw, ts.IndexKind.Number);
                        if (elem) {
                            const props = this.typeChecker.getPropertiesOfType(this.typeChecker.getApparentType(elem));
                            const elemHasMethod = props.some((p) => {
                                try {
                                    const decl = p.valueDeclaration ?? p.declarations?.[0];
                                    if (!decl) return false;
                                    const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                    return (t.getCallSignatures()?.length || 0) > 0;
                                } catch {
                                    return false;
                                }
                            });
                            if (elemHasMethod) {
                                // IMPORTANT: Do NOT replace the raw (array) with the element type. The nested
                                // conditional branch 'T extends (infer E)[] ?' needs the original array raw
                                // to successfully infer E. We only record the element as a concreteRaw so that
                                // later method pattern detection can still discover methods (e.g., toJSON) on
                                // the element while preserving array shape for inference.
                                try {
                                    (context as any).pushConcreteRaw?.(nameSymbol.name, elem);
                                } catch {
                                    /* ignore */
                                }
                                // Optionally prioritize element in ordered originals (without losing array raw at its own position)
                                try {
                                    const ordered: ts.Type[] = (context as any).originalTypesInOrder || [];
                                    // Avoid duplicate insertion
                                    if (!ordered.includes(elem)) {
                                        (context as any).originalTypesInOrder = [elem, ...ordered];
                                    }
                                } catch {
                                    /* ignore */
                                }
                            }
                        }
                    } catch {
                        /* ignore */
                    }
                    let skipOverride = false;
                    if (existingOriginal && isIndexed) {
                        try {
                            const existingProps = this.typeChecker.getPropertiesOfType(existingOriginal);
                            if (existingProps.length > 0) {
                                skipOverride = true; // keep richer original (with methods)
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                    // Additional protection: if existing original has method(s) and new raw lacks them, keep existing.
                    if (existingOriginal) {
                        try {
                            const existingProps = this.typeChecker.getPropertiesOfType(existingOriginal);
                            const existingMethods = existingProps.filter((p) => {
                                try {
                                    const decl = p.valueDeclaration ?? p.declarations?.[0];
                                    if (!decl) return false;
                                    const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                    return (t.getCallSignatures()?.length || 0) > 0;
                                } catch {
                                    return false;
                                }
                            });
                            const newProps = this.typeChecker.getPropertiesOfType(raw);
                            const newMethods = newProps.filter((p) => {
                                try {
                                    const decl = p.valueDeclaration ?? p.declarations?.[0];
                                    if (!decl) return false;
                                    const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                    return (t.getCallSignatures()?.length || 0) > 0;
                                } catch {
                                    return false;
                                }
                            });
                            if (existingMethods.length > 0 && newMethods.length === 0) {
                                skipOverride = true;
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                    // Attempt to unwrap indexed access raw (T[K]) to property raw type of original T
                    if (!skipOverride && isIndexed) {
                        try {
                            const idxRaw: any = raw; // ts.IndexedAccessType
                            const objectType: ts.Type = idxRaw.objectType;
                            const indexType: ts.Type = idxRaw.indexType;
                            const objectSymbol = objectType.getSymbol();
                            // If objectType is the generic parameter itself, try parent original
                            if (objectSymbol && (objectType.flags & ts.TypeFlags.TypeParameter) !== 0) {
                                const paramBaseName = objectSymbol.getName();
                                const parentOriginal = context.getOriginalType(paramBaseName);
                                if (parentOriginal) {
                                    let keyNames: string[] = [];
                                    if ((indexType.flags & ts.TypeFlags.Union) !== 0) {
                                        keyNames = (indexType as ts.UnionType).types.map((t) =>
                                            this.typeChecker.typeToString(t),
                                        );
                                    } else {
                                        keyNames = [this.typeChecker.typeToString(indexType)];
                                    }
                                    const props = this.typeChecker.getPropertiesOfType(parentOriginal);
                                    for (const kn of keyNames) {
                                        const propSym = props.find((p) => p.getName() === kn);
                                        if (propSym) {
                                            const decl = propSym.valueDeclaration ?? propSym.declarations?.[0];
                                            if (decl) {
                                                const propRaw = this.typeChecker.getTypeOfSymbolAtLocation(
                                                    propSym,
                                                    decl,
                                                );
                                                if (propRaw) {
                                                    // Replace raw with property raw type
                                                    // so that conditional toJSON pattern can see method.
                                                    raw = propRaw;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                    if (!skipOverride) {
                        context.pushOriginalType(nameSymbol.name, raw);
                        // Store deterministic concreteRaw if raw is not a naked type parameter OR it has at least one method.
                        try {
                            const existingConcrete: ts.Type | undefined = (context as any).getConcreteRaw?.(
                                nameSymbol.name,
                            );
                            const rawHasMethod = this.typeChecker.getPropertiesOfType(raw).some((p) => {
                                try {
                                    const decl = p.valueDeclaration ?? p.declarations?.[0];
                                    if (!decl) return false;
                                    const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                    return (t.getCallSignatures()?.length || 0) > 0;
                                } catch {
                                    return false;
                                }
                            });
                            let existingHasMethod = false;
                            if (existingConcrete) {
                                try {
                                    existingHasMethod = this.typeChecker
                                        .getPropertiesOfType(existingConcrete)
                                        .some((p) => {
                                            try {
                                                const decl = p.valueDeclaration ?? p.declarations?.[0];
                                                if (!decl) return false;
                                                const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                                return (t.getCallSignatures()?.length || 0) > 0;
                                            } catch {
                                                return false;
                                            }
                                        });
                                } catch {
                                    /* ignore */
                                }
                            }
                            const rawIsTypeParam = (raw.flags & ts.TypeFlags.TypeParameter) !== 0;
                            // Overwrite rules:
                            // 1. If no existing concrete, store if raw has method or not a type param.
                            // 2. If existing has method, never overwrite with a non-method-bearing raw or naked type param.
                            // 3. If existing lacks method and new raw has method, overwrite.
                            let shouldStore = false;
                            if (!existingConcrete) {
                                shouldStore = rawHasMethod || !rawIsTypeParam;
                            } else if (existingHasMethod) {
                                shouldStore = rawHasMethod && !rawIsTypeParam; // upgrade only if equal richness? keep strict; rarely triggered
                            } else if (!existingHasMethod) {
                                shouldStore = rawHasMethod || (!rawIsTypeParam && raw.flags !== existingConcrete.flags);
                            }
                            if (shouldStore) {
                                (context as any).pushConcreteRaw?.(nameSymbol.name, raw);
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                }

                if (typeParam.default) {
                    const type = this.childNodeParser.createType(typeParam.default, context);
                    context.setDefault(nameSymbol.name, type);
                }
            }
            // Fallback pass: if any alias param has no original raw but ordered originals exist, bind by index.
            for (let i = 0; i < node.typeParameters.length; i++) {
                const typeParam = node.typeParameters[i];
                const nameSymbol = this.typeChecker.getSymbolAtLocation(typeParam.name)!;
                if (!context.getOriginalType(nameSymbol.name)) {
                    const raw = context.getOriginalTypeByIndex(i);
                    if (raw) context.pushOriginalType(nameSymbol.name, raw);
                }
            }
        }

        // Step 2: if descriptor was built, attempt to pre-bind any infer variables from method-return segments.
        if (descriptorBuilt) {
            try {
                const desc = buildAliasDescriptor(node); // retrieve cached
                // Step 3 (array element promotion prior to method binding):
                // If the alias contains both an array-infer segment and a later method-return-infer segment,
                // and the currently bound raw for the generic parameter is still an array when we are in a
                // recursive invocation (where we would prefer the element type), promote the element type
                // (non-destructively) as a concreteRaw and, if it has methods, as the original type.
                try {
                    const hasArrayInfer = desc.chain.some((s) => s.pattern === "array-infer");
                    const hasMethodInfer = desc.chain.some((s) => s.pattern === "method-return-infer");
                    if (hasArrayInfer && hasMethodInfer && node.typeParameters?.length) {
                        for (const tp of node.typeParameters) {
                            const pname = tp.name.text;
                            let raw = context.getOriginalType(pname) || (context as any).getConcreteRaw?.(pname);
                            if (!raw) continue;
                            // Only promote if raw is array and element appears to have at least one method (generic) OR its element's class has methods
                            const elem = this.typeChecker.getIndexTypeOfType(raw, ts.IndexKind.Number);
                            if (!elem) continue;
                            let promote = false;
                            try {
                                const props = this.typeChecker.getPropertiesOfType(
                                    this.typeChecker.getApparentType(elem),
                                );
                                promote = props.some((p) => {
                                    try {
                                        const decl = p.valueDeclaration ?? p.declarations?.[0];
                                        if (!decl) return false;
                                        const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                        return (t.getCallSignatures()?.length || 0) > 0;
                                    } catch {
                                        return false;
                                    }
                                });
                                // Class declaration enrichment if method not directly on apparent type
                                if (!promote) {
                                    const sym = (elem as any).symbol as ts.Symbol | undefined;
                                    const decls = sym?.declarations || [];
                                    for (const d of decls) {
                                        if (ts.isClassDeclaration(d)) {
                                            const classType = this.typeChecker.getTypeAtLocation(d);
                                            const classProps = this.typeChecker.getPropertiesOfType(classType);
                                            if (
                                                classProps.some(
                                                    (p) =>
                                                        p.getName() === "toJSON" ||
                                                        (p.getFlags() & ts.SymbolFlags.Method) !== 0,
                                                )
                                            ) {
                                                raw = classType; // use enriched class type as element
                                                promote = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                            } catch {
                                /* ignore */
                            }
                            if (!promote) continue;
                            // Avoid overwriting an existing original that already has methods (non-array)
                            const existing = context.getOriginalType(pname);
                            let existingHasMethods = false;
                            if (
                                existing &&
                                this.typeChecker.getIndexTypeOfType(existing, ts.IndexKind.Number) == null
                            ) {
                                try {
                                    existingHasMethods = this.typeChecker.getPropertiesOfType(existing).some((p) => {
                                        try {
                                            const decl = p.valueDeclaration ?? p.declarations?.[0];
                                            if (!decl) return false;
                                            const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                            return (t.getCallSignatures()?.length || 0) > 0;
                                        } catch {
                                            return false;
                                        }
                                    });
                                } catch {
                                    /* ignore */
                                }
                            }
                            if (!existingHasMethods) {
                                debugLog(
                                    "[debug step3 promote] param",
                                    pname,
                                    "array element promoted to method-bearing type",
                                );
                                try {
                                    (context as any).pushConcreteRaw?.(pname, raw);
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    context.pushOriginalType(pname, raw);
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    const ordered: ts.Type[] = (context as any).originalTypesInOrder || [];
                                    if (!ordered.includes(raw))
                                        (context as any).originalTypesInOrder = [raw, ...ordered];
                                } catch {
                                    /* ignore */
                                }
                            }
                        }
                    }
                } catch {
                    /* ignore */
                }
                const bindings = attemptBindMethodReturn(desc, this.typeChecker, context);
                if (bindings.length)
                    debugLog(
                        "[debug method-return bindings]",
                        bindings.map((b) => `${b.methodName}->${this.typeChecker.typeToString(b.returnType)}`),
                    );
            } catch {
                /* ignore */
            }
        }

        const id = this.getTypeId(node, context);
        const name = this.getTypeName(node, context);
        if (reference) {
            reference.setId(id);
            reference.setName(name);
        }

        // Detect presence of 'infer' within the alias type definition.
        let underlyingNode: ts.TypeNode = node.type;
        // Structural optimization: conditional alias of form
        //   T extends { method(): infer U } ? U : ...
        // When the bound raw for T has the method, replace alias with method return type directly.
        try {
            if (ts.isConditionalTypeNode(underlyingNode) && ts.isTypeLiteralNode(underlyingNode.extendsType)) {
                const methodMembers = underlyingNode.extendsType.members.filter((m) => ts.isMethodSignature(m));
                if (methodMembers.length === 1 && ts.isMethodSignature(methodMembers[0])) {
                    const sigMember = methodMembers[0];
                    const ret = sigMember.type;
                    if (ret && ts.isInferTypeNode(ret)) {
                        const inferName = ret.typeParameter.name.text;
                        // Check that checkType is the first (or only) type parameter reference.
                        if (underlyingNode.checkType && node.typeParameters?.length) {
                            const firstParamName = node.typeParameters[0].name.text;
                            let boundRawPrimary = context.getOriginalType(firstParamName);
                            if (!boundRawPrimary) {
                                try {
                                    boundRawPrimary = (context as any).getConcreteRaw?.(firstParamName);
                                } catch {
                                    /* ignore */
                                }
                            }
                            const methodName =
                                sigMember.name && ts.isIdentifier(sigMember.name) ? sigMember.name.text : undefined;
                            if (methodName) {
                                const candidates: ts.Type[] = [];
                                if (boundRawPrimary) candidates.push(boundRawPrimary);
                                try {
                                    const concrete = (context as any).getConcreteRaw?.(firstParamName);
                                    if (concrete && !candidates.includes(concrete)) candidates.push(concrete);
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    const ordered: ts.Type[] = (context as any).originalTypesInOrder || [];
                                    for (const o of ordered) if (!candidates.includes(o)) candidates.push(o);
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    const globalElem: ts.Type | undefined = (globalThis as any).__lastMethodElementRaw;
                                    if (globalElem && !candidates.includes(globalElem)) candidates.push(globalElem);
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    const ctxElem: ts.Type | undefined = (context as any)._lastMethodElementRaw;
                                    if (ctxElem && !candidates.includes(ctxElem)) candidates.push(ctxElem);
                                } catch {
                                    /* ignore */
                                }
                                for (const cand of candidates) {
                                    // Expand candidate set with its element type if it's an array-like and element may host the method.
                                    const testCandidates: ts.Type[] = [cand];
                                    try {
                                        const elem = this.typeChecker.getIndexTypeOfType(cand, ts.IndexKind.Number);
                                        if (elem && !testCandidates.includes(elem)) testCandidates.push(elem);
                                    } catch {
                                        /* ignore */
                                    }
                                    for (const testCand of testCandidates) {
                                        let hasMethod = false;
                                        try {
                                            hasMethod = this.typeChecker
                                                .getPropertiesOfType(testCand)
                                                .some((s) => s.getName() === methodName);
                                        } catch {
                                            /* ignore */
                                        }
                                        if (!hasMethod) continue;
                                        try {
                                            const methodSym = this.typeChecker
                                                .getPropertiesOfType(testCand)
                                                .find((s) => s.getName() === methodName);
                                            const decl = methodSym?.valueDeclaration ?? methodSym?.declarations?.[0];
                                            if (methodSym && decl) {
                                                const methodType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                    methodSym,
                                                    decl,
                                                );
                                                const sig = methodType.getCallSignatures()?.[0];
                                                if (sig) {
                                                    const retType = sig.getReturnType();
                                                    let rebuilt: ts.TypeNode | undefined;
                                                    try {
                                                        const props = this.typeChecker.getPropertiesOfType(retType);
                                                        if (props.length) {
                                                            const members: ts.TypeElement[] = [];
                                                            for (const p of props) {
                                                                const pDecl = p.valueDeclaration ?? p.declarations?.[0];
                                                                let pType: ts.Type | undefined;
                                                                try {
                                                                    pType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                                        p,
                                                                        pDecl ?? decl,
                                                                    );
                                                                } catch {
                                                                    /* ignore */
                                                                }
                                                                const pTypeNode = pType
                                                                    ? this.typeChecker.typeToTypeNode(
                                                                          pType,
                                                                          undefined,
                                                                          ts.NodeBuilderFlags.NoTruncation,
                                                                      )
                                                                    : ts.factory.createKeywordTypeNode(
                                                                          ts.SyntaxKind.AnyKeyword,
                                                                      );
                                                                members.push(
                                                                    ts.factory.createPropertySignature(
                                                                        undefined,
                                                                        ts.factory.createIdentifier(p.getName()),
                                                                        undefined,
                                                                        pTypeNode as ts.TypeNode,
                                                                    ),
                                                                );
                                                            }
                                                            rebuilt = ts.factory.createTypeLiteralNode(members);
                                                        }
                                                    } catch {
                                                        /* ignore */
                                                    }
                                                    const retNode =
                                                        rebuilt ||
                                                        this.typeChecker.typeToTypeNode(
                                                            retType,
                                                            undefined,
                                                            ts.NodeBuilderFlags.NoTruncation,
                                                        );
                                                    if (retNode && ts.isTypeNode(retNode)) {
                                                        const direct = this.childNodeParser.createType(
                                                            retNode as ts.TypeNode,
                                                            context,
                                                        );
                                                        if (direct && !(direct instanceof NeverType)) {
                                                            return new AliasType(id, direct);
                                                        }
                                                    }
                                                }
                                            }
                                        } catch {
                                            /* ignore */
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch {
            /* ignore */
        }
        const type = this.childNodeParser.createType(underlyingNode, context);
        if (type instanceof NeverType) {
            return new NeverType();
        }
        return new AliasType(id, type);
    }

    protected getTypeId(node: ts.TypeAliasDeclaration, context: Context): string {
        return `alias-${getKey(node, context)}`;
    }

    protected getTypeName(node: ts.TypeAliasDeclaration, context: Context): string {
        const argumentIds = context.getArguments().map((arg) => arg?.getName());
        const fullName = node.name.getText();

        return argumentIds.length ? `${fullName}<${argumentIds.join(",")}>` : fullName;
    }
}
