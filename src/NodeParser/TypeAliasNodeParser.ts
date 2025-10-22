import ts from "typescript";
import type { Context, NodeParser } from "../NodeParser.js";
import type { SubNodeParser } from "../SubNodeParser.js";
import { AliasType } from "../Type/AliasType.js";
import type { BaseType } from "../Type/BaseType.js";
import { NeverType } from "../Type/NeverType.js";
import type { ReferenceType } from "../Type/ReferenceType.js";
import { getKey } from "../Utils/nodeKey.js";

export class TypeAliasNodeParser implements SubNodeParser {
    public constructor(
        protected typeChecker: ts.TypeChecker,
        protected childNodeParser: NodeParser,
    ) {}

    // Debug flag for verbose alias parsing logs
    private static readonly DEBUG_TYPES = process.env.TS_SCHEMA_DEBUG === "1";

    public supportsNode(node: ts.TypeAliasDeclaration): boolean {
        return node.kind === ts.SyntaxKind.TypeAliasDeclaration;
    }

    public createType(node: ts.TypeAliasDeclaration, context: Context, reference?: ReferenceType): BaseType {
        if (TypeAliasNodeParser.DEBUG_TYPES) {
            try {
                const concreteKeys = Array.from(((context as any).getAllConcreteRaws?.() || new Map()).keys());
                console.log(
                    "[Alias] entering alias",
                    node.name.getText(),
                    "concreteRaw keys",
                    concreteKeys,
                    "originalType keys",
                    Array.from(context.getOriginalTypes().keys()),
                );
            } catch {
                /* ignore */
            }
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
                            if (TypeAliasNodeParser.DEBUG_TYPES)
                                console.log(
                                    "  prefer existing concreteRaw for",
                                    nameSymbol.name,
                                    this.typeChecker.typeToString(existingConcrete),
                                );
                        }
                    }
                } catch {
                    /* ignore */
                }
                // Forced element raw fallback (added by ConditionalTypeNodeParser universal array infer)
                try {
                    const forced = (context as any)._forcedJsonifyElementRaw as ts.Type | undefined;
                    if (forced) {
                        // Use forced if no raw OR current raw is a naked type parameter (likely lost concrete) OR current raw has zero props while forced has some
                        let useForced = !raw;
                        try {
                            if (!useForced && raw) {
                                const isTypeParam = (raw.flags & ts.TypeFlags.TypeParameter) !== 0;
                                if (isTypeParam) useForced = true;
                                else {
                                    const rawProps = this.typeChecker.getPropertiesOfType(raw);
                                    const forcedProps = this.typeChecker.getPropertiesOfType(forced);
                                    if (rawProps.length === 0 && forcedProps.length > 0) useForced = true;
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                        if (useForced) {
                            raw = forced;
                            if (TypeAliasNodeParser.DEBUG_TYPES)
                                console.log(
                                    "  using forced element raw for",
                                    nameSymbol.name,
                                    this.typeChecker.typeToString(forced),
                                );
                        }
                    }
                    // Global fallback (last known element raw) if still a naked type parameter
                    if (
                        raw &&
                        (raw.flags & ts.TypeFlags.TypeParameter) !== 0 &&
                        !(context as any)._forcedJsonifyElementRaw
                    ) {
                        try {
                            const globalForced: ts.Type | undefined = (globalThis as any).__jsonifyElementRaw;
                            if (globalForced) {
                                const props = this.typeChecker.getPropertiesOfType(globalForced);
                                const hasMethod = props.some((p) => {
                                    try {
                                        const decl = p.valueDeclaration ?? p.declarations?.[0];
                                        if (!decl) return false;
                                        const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                        return (t.getCallSignatures()?.length || 0) > 0;
                                    } catch {
                                        return false;
                                    }
                                });
                                if (hasMethod) {
                                    raw = globalForced;
                                    if (TypeAliasNodeParser.DEBUG_TYPES)
                                        console.log(
                                            "  global forced element raw for",
                                            nameSymbol.name,
                                            this.typeChecker.typeToString(globalForced),
                                        );
                                }
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
                            if (TypeAliasNodeParser.DEBUG_TYPES)
                                console.log(
                                    "  replacing type parameter raw with index candidate for",
                                    nameSymbol.name,
                                    this.typeChecker.typeToString(indexCandidate),
                                );
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
                                    if (TypeAliasNodeParser.DEBUG_TYPES)
                                        console.log(
                                            "  ordered rescue (pre-binding) replacing type parameter raw for",
                                            nameSymbol.name,
                                            "with",
                                            this.typeChecker.typeToString(cand),
                                        );
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
                                        if (!alt) alt = (context as any)._forcedJsonifyElementRaw; // last resort
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
                                // Fallback: if alt not found, try _jsonifyElementRaw stored in context (for Jsonify<E>[] scenario)
                                if (!alt) {
                                    try {
                                        const fallback = (context as any)._jsonifyElementRaw as ts.Type | undefined;
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
                            // Rescue: if still a naked type parameter, scan ordered originals for concrete method-bearing candidate (e.g., toJSON)
                            if ((raw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                                try {
                                    const ordered: ts.Type[] = (context as any).originalTypesInOrder || [];
                                    for (const cand of ordered) {
                                        if ((cand.flags & ts.TypeFlags.TypeParameter) !== 0) continue;
                                        let hasMethod = false;
                                        try {
                                            const props = this.typeChecker.getPropertiesOfType(cand);
                                            hasMethod = props.some((p) => p.getName && p.getName() === "toJSON");
                                        } catch {
                                            /* ignore */
                                        }
                                        if (hasMethod) {
                                            raw = cand;
                                            break;
                                        }
                                    }
                                } catch {
                                    /* ignore */
                                }
                            }
                        }
                    } catch {
                        /* ignore */
                    }
                    // If after all substitutions raw is still a naked type parameter, attempt deterministic concreteRaw substitution (e.g., pick the one having toJSON())
                    try {
                        if ((raw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                            const concretes: Map<string, ts.Type> | undefined = (context as any).getAllConcreteRaws?.();
                            if (concretes) {
                                for (const c of concretes.values()) {
                                    if ((c.flags & ts.TypeFlags.TypeParameter) !== 0) continue;
                                    // Look for a toJSON method signature (generic serializer pattern)
                                    let hasToJSON = false;
                                    try {
                                        hasToJSON = this.typeChecker
                                            .getPropertiesOfType(c)
                                            .some((p) => p.getName && p.getName() === "toJSON");
                                    } catch {
                                        /* ignore */
                                    }
                                    if (hasToJSON) {
                                        raw = c;
                                        break;
                                    }
                                }
                            } else {
                                // Try forced element raw
                                try {
                                    const forced = (context as any)._forcedJsonifyElementRaw as ts.Type | undefined;
                                    if (forced) {
                                        const hasToJSON = this.typeChecker
                                            .getPropertiesOfType(forced)
                                            .some((p) => p.getName && p.getName() === "toJSON");
                                        if (hasToJSON) {
                                            raw = forced;
                                            if (TypeAliasNodeParser.DEBUG_TYPES)
                                                console.log(
                                                    "  forced element raw rescue for",
                                                    nameSymbol.name,
                                                    this.typeChecker.typeToString(forced),
                                                );
                                        }
                                    }
                                } catch {
                                    /* ignore */
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
                                if (TypeAliasNodeParser.DEBUG_TYPES)
                                    console.log(
                                        "  enriching array raw for",
                                        nameSymbol.name,
                                        "using element type",
                                        this.typeChecker.typeToString(elem),
                                    );
                                try {
                                    (context as any).pushConcreteRaw?.(nameSymbol.name, elem);
                                    if (TypeAliasNodeParser.DEBUG_TYPES)
                                        console.log(
                                            "  concreteRaw stored (array element) for",
                                            nameSymbol.name,
                                            this.typeChecker.typeToString(elem),
                                        );
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
                                if (TypeAliasNodeParser.DEBUG_TYPES)
                                    console.log(
                                        "  skip overriding original raw for",
                                        nameSymbol.name,
                                        "with indexed access raw",
                                    );
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
                                if (TypeAliasNodeParser.DEBUG_TYPES)
                                    console.log(
                                        "  skip overriding method-bearing original for",
                                        nameSymbol.name,
                                        "methods:",
                                        existingMethods.map((m) => m.getName()),
                                    );
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
                                                    if (TypeAliasNodeParser.DEBUG_TYPES)
                                                        console.log(
                                                            "  unwrapped indexed access raw for alias param",
                                                            nameSymbol.name,
                                                            "property",
                                                            kn,
                                                            this.typeChecker.typeToString(propRaw),
                                                        );
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
                                if (TypeAliasNodeParser.DEBUG_TYPES)
                                    console.log(
                                        "  concreteRaw stored for",
                                        nameSymbol.name,
                                        this.typeChecker.typeToString(raw),
                                    );
                            } else if (TypeAliasNodeParser.DEBUG_TYPES) {
                                try {
                                    console.log("  concreteRaw skip overwrite for", nameSymbol.name);
                                } catch {}
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

        const id = this.getTypeId(node, context);
        const name = this.getTypeName(node, context);
        if (reference) {
            reference.setId(id);
            reference.setName(name);
        }

        // Detect presence of 'infer' within the alias type definition.
        const hasInfer = this.containsInfer(node.type);
        let underlyingNode: ts.TypeNode = node.type;
        if (TypeAliasNodeParser.DEBUG_TYPES)
            console.log("hasInfer", hasInfer, safeNodePrint(node.type, node.getSourceFile(), this.typeChecker));
        if (hasInfer && false) {
            try {
                const sourceTsType = this.typeChecker.getTypeAtLocation(node.type);
                const apparent = this.typeChecker.getApparentType(sourceTsType);
                if (apparent !== sourceTsType) {
                    const apparentNode = this.typeChecker.typeToTypeNode(
                        apparent,
                        node,
                        ts.NodeBuilderFlags.NoTruncation,
                    );
                    if (apparentNode) {
                        const apparentNodeChecked: ts.Node = apparentNode!; // non-undefined after guard
                        if (ts.isTypeNode(apparentNodeChecked)) {
                            underlyingNode = apparentNodeChecked as ts.TypeNode;
                        }
                    }
                    if (TypeAliasNodeParser.DEBUG_TYPES)
                        console.log(
                            "  apparent",
                            safeNodePrint(underlyingNode, node.getSourceFile(), this.typeChecker),
                        );
                }
            } catch (e) {
                // Swallow; fallback to original node
                if (TypeAliasNodeParser.DEBUG_TYPES) console.log("hasInfer error", e);
            }
        }
        const type = this.childNodeParser.createType(underlyingNode, context);
        if (type instanceof NeverType) {
            return new NeverType();
        }
        return new AliasType(id, type);
    }

    private containsInfer(node: ts.TypeNode): boolean {
        let found = false;
        const visit = (n: ts.Node) => {
            if (found) return;
            if (n.kind === ts.SyntaxKind.InferType) {
                found = true;
                return;
            }
            n.forEachChild(visit);
        };
        visit(node);
        return found;
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
function safeNodePrint(type: ts.TypeNode, arg1: ts.SourceFile, typeChecker: ts.TypeChecker): any {
    try {
        const printer = ts.createPrinter({ removeComments: true });
        const printed = printer.printNode(ts.EmitHint.Unspecified, type, arg1);
        const tsType = typeChecker.getTypeAtLocation(type);
        let typeString: string;
        try {
            typeString = typeChecker.typeToString(tsType, undefined, ts.TypeFormatFlags.NoTruncation);
        } catch {
            typeString = typeChecker.typeToString(tsType);
        }
        return {
            printed,
            type: typeString,
            kind: ts.SyntaxKind[type.kind],
            flags: tsType.flags,
            aliasSymbol: tsType.aliasSymbol?.escapedName,
        };
    } catch (e) {
        try {
            const fallback = typeChecker.typeToString(typeChecker.getTypeAtLocation(type));
            return { printed: fallback, error: String(e) };
        } catch {
            return { printed: "/*error printing type*/", error: String(e) };
        }
    }
}
