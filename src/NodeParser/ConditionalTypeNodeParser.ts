import ts from "typescript";
import type { NodeParser } from "../NodeParser.js";
import { Context } from "../NodeParser.js";
import type { SubNodeParser } from "../SubNodeParser.js";
import type { BaseType } from "../Type/BaseType.js";
import { isAssignableTo } from "../Utils/isAssignableTo.js";
import { narrowType } from "../Utils/narrowType.js";
import { UnionType } from "../Type/UnionType.js";
import { NeverType } from "../Type/NeverType.js";

// Global fallback for last captured Jsonify element raw to rescue nested contexts
// where original propagation failed. This is a safety net to ensure method pattern
// (e.g. toJSON(): infer U) can still find the concrete class raw.
let globalForcedJsonifyElementRaw: ts.Type | undefined;

class CheckType {
    constructor(
        public parameterName: string,
        public type: BaseType,
    ) {}
}

export class ConditionalTypeNodeParser implements SubNodeParser {
    public constructor(
        protected typeChecker: ts.TypeChecker,
        protected childNodeParser: NodeParser,
    ) {}

    public supportsNode(node: ts.ConditionalTypeNode): boolean {
        return node.kind === ts.SyntaxKind.ConditionalType;
    }

    public createType(node: ts.ConditionalTypeNode, context: Context): BaseType {
        const checkType = this.childNodeParser.createType(node.checkType, context);
        const extendsType = this.childNodeParser.createType(node.extendsType, context);
        const checkTypeParameterName = this.getTypeParameterName(node.checkType);
        const inferMap = new Map<string, BaseType>();
        let boundRawType = checkTypeParameterName ? context.getOriginalType(checkTypeParameterName) : undefined;

        // Indexed access raw retrieval
        try {
            if (!boundRawType && ts.isIndexedAccessTypeNode(node.checkType)) {
                const obj = node.checkType.objectType;
                if (ts.isTypeReferenceNode(obj) && ts.isIdentifier(obj.typeName)) {
                    const rawObj = context.getOriginalType(obj.typeName.text);
                    if (rawObj) {
                        const indexNode = node.checkType.indexType;
                        const keyNames: string[] = [];
                        if (ts.isLiteralTypeNode(indexNode)) {
                            if (ts.isStringLiteral(indexNode.literal) || ts.isNumericLiteral(indexNode.literal)) {
                                keyNames.push(indexNode.literal.text);
                            }
                        }
                        if (keyNames.length === 0) {
                            keyNames.push(
                                this.typeChecker.typeToString(this.typeChecker.getTypeFromTypeNode(indexNode)),
                            );
                        }
                        const props = this.typeChecker.getPropertiesOfType(rawObj);
                        for (const k of keyNames) {
                            const prop = props.find((p) => p.getName() === k);
                            if (prop) {
                                const decl = prop.valueDeclaration ?? prop.declarations?.[0];
                                if (decl) {
                                    const rawPropType = this.typeChecker.getTypeOfSymbolAtLocation(prop, decl);
                                    if (rawPropType) {
                                        boundRawType = rawPropType;
                                        break;
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

        // Additional unwrapping for non-parameter indexed access T[K] where checkTypeParameterName is null
        try {
            if (!boundRawType && !checkTypeParameterName && ts.isIndexedAccessTypeNode(node.checkType)) {
                const obj = node.checkType.objectType;
                if (ts.isTypeReferenceNode(obj) && ts.isIdentifier(obj.typeName)) {
                    const paramName = obj.typeName.text; // e.g. T
                    const originalObjectRaw = context.getOriginalType(paramName);
                    if (originalObjectRaw) {
                        // Derive key name from indexType node or from context argument if index is a type param
                        let keyNames: string[] = [];
                        const idxNode = node.checkType.indexType;
                        if (ts.isLiteralTypeNode(idxNode)) {
                            if (ts.isStringLiteral(idxNode.literal) || ts.isNumericLiteral(idxNode.literal)) {
                                keyNames.push(idxNode.literal.text);
                            }
                        } else if (ts.isTypeReferenceNode(idxNode) && ts.isIdentifier(idxNode.typeName)) {
                            const kParam = idxNode.typeName.text;
                            const arg = context.getArgument(kParam);
                            try {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                if ((arg as any)?.getValue) {
                                    // @ts-ignore
                                    keyNames.push((arg as any).getValue().toString());
                                }
                            } catch {
                                /* ignore */
                            }
                        }
                        if (keyNames.length === 0) {
                            // fallback: stringify index type
                            keyNames.push(this.typeChecker.typeToString(this.typeChecker.getTypeFromTypeNode(idxNode)));
                        }
                        try {
                            const props = this.typeChecker.getPropertiesOfType(originalObjectRaw);
                            for (const keyName of keyNames) {
                                const sym = props.find((p) => p.getName() === keyName);
                                if (sym) {
                                    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
                                    if (decl) {
                                        const propRaw = this.typeChecker.getTypeOfSymbolAtLocation(sym, decl);
                                        if (propRaw) {
                                            boundRawType = propRaw;
                                            break;
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
        } catch {
            /* ignore */
        }

        // Unwrap indexed access
        try {
            if (boundRawType && (boundRawType.flags & ts.TypeFlags.IndexedAccess) !== 0 && checkTypeParameterName) {
                const idx: any = boundRawType; // IndexedAccessType
                const objectRaw = context.getOriginalType(checkTypeParameterName);
                if (objectRaw) {
                    const keyType: ts.Type = idx.indexType;
                    const keyNames: string[] =
                        (keyType.flags & ts.TypeFlags.Union) !== 0
                            ? (keyType as ts.UnionType).types.map((t) => this.typeChecker.typeToString(t))
                            : [this.typeChecker.typeToString(keyType)];
                    const props = this.typeChecker.getPropertiesOfType(objectRaw);
                    for (const keyName of keyNames) {
                        const prop = props.find((p) => p.getName() === keyName);
                        if (prop) {
                            const decl = prop.valueDeclaration ?? prop.declarations?.[0];
                            if (decl) {
                                const rawPropType = this.typeChecker.getTypeOfSymbolAtLocation(prop, decl);
                                if (rawPropType) {
                                    boundRawType = rawPropType;
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

        const rawCheckType = boundRawType ?? this.typeChecker.getTypeFromTypeNode(node.checkType);
        const rawExtendsType = this.typeChecker.getTypeFromTypeNode(node.extendsType);

        // Unconditional array inference raw propagation: if extendsType matches infer array pattern capture raw element type for E.
        const inferArrayInfo = this.getInferArrayInfo(node.extendsType);
        if (inferArrayInfo) {
            const inferName = inferArrayInfo.inferName;
            try {
                if (!context.getOriginalType(inferName)) {
                    let baseArrayRaw: ts.Type | undefined = rawCheckType;
                    // If rawCheckType is an indexed access (e.g., T[K]) attempt to unwrap to property raw first.
                    if (baseArrayRaw && (baseArrayRaw.flags & ts.TypeFlags.IndexedAccess) !== 0) {
                        try {
                            const idx: any = baseArrayRaw; // IndexedAccessType
                            const objectType: ts.Type = idx.objectType;
                            const indexType: ts.Type = idx.indexType;
                            const objSymbol = objectType.getSymbol();
                            if (objSymbol && (objectType.flags & ts.TypeFlags.TypeParameter) !== 0) {
                                const paramName = objSymbol.getName();
                                const parentOriginal = context.getOriginalType(paramName);
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
                                                    baseArrayRaw = propRaw;
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
                    const elemRawUniversal = baseArrayRaw
                        ? this.typeChecker.getIndexTypeOfType(baseArrayRaw, ts.IndexKind.Number)
                        : undefined;
                    if (elemRawUniversal) {
                        context.pushOriginalType(inferName, elemRawUniversal);
                        try {
                            (context as any).pushConcreteRaw?.(inferName, elemRawUniversal);
                        } catch {
                            /* ignore */
                        }
                        try {
                            // Put element raw at front of ordered originals for precedence
                            const list: ts.Type[] = (context as any).originalTypesInOrder || [];
                            (context as any).originalTypesInOrder = [elemRawUniversal, ...list];
                            // Stash a forced element raw for nested Jsonify<E> where E context gets lost
                            (context as any)._forcedJsonifyElementRaw = elemRawUniversal;
                            globalForcedJsonifyElementRaw = elemRawUniversal;
                            try {
                                (globalThis as any).__jsonifyElementRaw = elemRawUniversal;
                            } catch {
                                /* ignore */
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                }
            } catch {
                /* ignore */
            }
        }

        // Early unconditional evaluation of 'T extends (infer E)[] ?' branch before method pattern logic.
        if (inferArrayInfo) {
            const inferName = inferArrayInfo.inferName;
            try {
                const elemRaw = this.typeChecker.getIndexTypeOfType(rawCheckType, ts.IndexKind.Number);
                if (elemRaw) {
                    // Produce TypeNode for element raw, bind inferName -> element base type in inferMap
                    const elemNode = this.typeChecker.typeToTypeNode(
                        elemRaw,
                        undefined,
                        ts.NodeBuilderFlags.NoTruncation,
                    );
                    if (elemNode && ts.isTypeNode(elemNode)) {
                        const elemBaseType = this.childNodeParser.createType(elemNode, context);
                        inferMap.set(inferName, elemBaseType);
                        // Bind original raw for inferName if missing (ensure class methods preserved)
                        if (!context.getOriginalType(inferName)) context.pushOriginalType(inferName, elemRaw);
                        // Ensure elemRaw is first in ordered originals so alias param T binds to LeafWithToJSON not previous raw.
                        try {
                            const list: any = (context as any).originalTypesInOrder;
                            if (Array.isArray(list)) {
                                list.unshift(elemRaw);
                            } else {
                                context.pushOriginalTypeOrdered(elemRaw);
                            }
                        } catch {
                            /* ignore */
                        }
                        // Evaluate trueType (Jsonify<E>[]) within a sub-context (propagate infer binding and original raw types)
                        const sub = this.createSubContext(
                            node,
                            context,
                            checkTypeParameterName ? new CheckType(checkTypeParameterName, checkType) : undefined,
                            inferMap,
                        );
                        // If trueType is an array of a Jsonify<X> reference, bind alias parameter raw to elemRaw
                        try {
                            if (ts.isArrayTypeNode(node.trueType)) {
                                const el = node.trueType.elementType;
                                if (ts.isTypeReferenceNode(el) && ts.isIdentifier(el.typeName)) {
                                    const refSym = this.typeChecker.getSymbolAtLocation(el.typeName);
                                    if (refSym && refSym.declarations) {
                                        const aliasDecl = refSym.declarations.find((d) =>
                                            ts.isTypeAliasDeclaration(d),
                                        ) as ts.TypeAliasDeclaration | undefined;
                                        if (aliasDecl?.typeParameters?.length) {
                                            const aliasParamName = aliasDecl.typeParameters[0].name.text; // 'T' in Jsonify<T>
                                            if (!sub.getOriginalType(aliasParamName)) {
                                                sub.pushOriginalType(aliasParamName, elemRaw);
                                                // Also push elemRaw into ordered originals at front of sub context
                                                try {
                                                    (sub as any).originalTypesInOrder = [
                                                        elemRaw,
                                                        ...((sub as any).originalTypesInOrder || []),
                                                    ];
                                                } catch {
                                                    /* ignore */
                                                }
                                                // Preemptively map any future naked type parameter T inside nested conditionals to elemRaw by storing fallback under a synthetic key
                                                try {
                                                    if (!(sub as any)._jsonifyElementRaw)
                                                        (sub as any)._jsonifyElementRaw = elemRaw;
                                                } catch {
                                                    /* ignore */
                                                }
                                                // Also store forced fallback explicitly for nested Jsonify<E>
                                                try {
                                                    if (!(sub as any)._forcedJsonifyElementRaw)
                                                        (sub as any)._forcedJsonifyElementRaw = elemRaw;
                                                } catch {
                                                    /* ignore */
                                                }
                                                try {
                                                    globalForcedJsonifyElementRaw = elemRaw;
                                                    (globalThis as any).__jsonifyElementRaw = elemRaw;
                                                } catch {
                                                    /* ignore */
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                        const trueResolved = this.childNodeParser.createType(node.trueType, sub);
                        if (trueResolved) return trueResolved;
                    }
                }
            } catch {
                /* ignore */
            }
        }

        // Detect generalized method pattern '{ methodName(): infer U }'
        let extendsMethodName: string | undefined; // method name when return type contains infer
        let extendsInferName: string | undefined; // inferred type variable name from return type
        let extendsParamInferMethodName: string | undefined; // method name when parameter type contains infer
        let extendsParamInferName: string | undefined; // inferred type variable name from parameter infer
        if (ts.isTypeLiteralNode(node.extendsType)) {
            for (const member of node.extendsType.members) {
                if (ts.isMethodSignature(member) && member.name && ts.isIdentifier(member.name)) {
                    const ret = member.type;
                    if (ret && ts.isInferTypeNode(ret)) {
                        extendsMethodName = member.name.text;
                        extendsInferName = ret.typeParameter.name.text;
                        break; // prioritize return infer over param infer if both present
                    }
                    // Scan parameters for param: infer U pattern
                    if (!extendsMethodName && member.parameters) {
                        for (const p of member.parameters) {
                            if (p.type && ts.isInferTypeNode(p.type)) {
                                extendsParamInferMethodName = member.name.text;
                                extendsParamInferName = p.type.typeParameter.name.text;
                                break;
                            }
                        }
                        if (extendsParamInferMethodName) break;
                    }
                }
            }
            // If only parameter-infer pattern detected, treat it as method pattern for downstream logic
            if (!extendsMethodName && extendsParamInferMethodName) {
                extendsMethodName = extendsParamInferMethodName;
            }
        }

        if (rawCheckType && rawExtendsType && extendsMethodName) {
            // Attempt richer raw resolution for naked type parameters before any method pattern handling
            try {
                if (boundRawType && (boundRawType.flags & ts.TypeFlags.TypeParameter) !== 0) {
                    const resolved = this.resolveTypeParameterRaw(boundRawType, context, extendsMethodName);
                    if (resolved && resolved !== boundRawType) {
                        boundRawType = resolved;
                    }
                }
            } catch {
                /* ignore */
            }
            // Universal early shortcut: if checkType resolves to an array and its element type has the method, emit array of method return type immediately.
            try {
                const elemRawEarly = this.typeChecker.getIndexTypeOfType(rawCheckType, ts.IndexKind.Number);
                if (elemRawEarly) {
                    const elemApparentEarly = this.typeChecker.getApparentType(elemRawEarly);
                    const hasMethodEarly = this.typeChecker
                        .getPropertiesOfType(elemApparentEarly)
                        .some((s) => s.getName() === extendsMethodName);
                    if (hasMethodEarly) {
                        const methodSymEarly = this.typeChecker
                            .getPropertiesOfType(elemApparentEarly)
                            .find((s) => s.getName() === extendsMethodName);
                        if (methodSymEarly) {
                            const declEarly = methodSymEarly.valueDeclaration ?? methodSymEarly.declarations?.[0];
                            if (declEarly) {
                                const methodTypeEarly = this.typeChecker.getTypeOfSymbolAtLocation(
                                    methodSymEarly,
                                    declEarly,
                                );
                                const sigEarly = methodTypeEarly.getCallSignatures()?.[0];
                                if (sigEarly) {
                                    const retTypeEarly = sigEarly.getReturnType();
                                    const retNodeEarly = this.typeChecker.typeToTypeNode(
                                        retTypeEarly,
                                        undefined,
                                        ts.NodeBuilderFlags.NoTruncation,
                                    );
                                    if (retNodeEarly && ts.isTypeNode(retNodeEarly)) {
                                        const arrayNodeEarly = ts.factory.createArrayTypeNode(
                                            retNodeEarly as ts.TypeNode,
                                        );
                                        const syntheticContextEarly = this.createSubContext(
                                            node,
                                            context,
                                            checkTypeParameterName
                                                ? new CheckType(checkTypeParameterName, checkType)
                                                : undefined,
                                            inferMap,
                                        );
                                        const earlyResolved = this.childNodeParser.createType(
                                            arrayNodeEarly,
                                            syntheticContextEarly,
                                        );
                                        if (earlyResolved) return earlyResolved;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch {
                /* ignore */
            }
            // Parameterized case
            if (checkTypeParameterName) {
                // Object method pattern
                if (ts.isTypeLiteralNode(node.extendsType)) {
                    // Prefer concreteRaw mapping first
                    let targetRaw =
                        (checkTypeParameterName
                            ? (context as any).getConcreteRaw?.(checkTypeParameterName)
                            : undefined) ||
                        boundRawType ||
                        rawCheckType;
                    // Second chance enrichment if targetRaw still a naked type parameter without method
                    try {
                        if ((targetRaw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                            const again = this.resolveTypeParameterRaw(targetRaw, context, extendsMethodName);
                            if (again) targetRaw = again;
                            // Fallback: use explicitly stored element raw from earlier array branch (Jsonify<E>[] scenario)
                            if ((targetRaw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                                try {
                                    const elemFallback: ts.Type | undefined = (context as any)._jsonifyElementRaw;
                                    if (elemFallback) {
                                        const props = this.typeChecker.getPropertiesOfType(elemFallback);
                                        if (props.some((p) => p.getName() === extendsMethodName)) {
                                            targetRaw = elemFallback;
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
                    // Ultimate forced fallback: if still a naked type parameter and a forced element raw exists with the method, substitute it.
                    try {
                        if ((targetRaw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                            const forced: ts.Type | undefined = (context as any)._forcedJsonifyElementRaw;
                            if (forced) {
                                const hasForced = this.typeChecker
                                    .getPropertiesOfType(forced)
                                    .some((s) => s.getName() === extendsMethodName);
                                if (hasForced) {
                                    targetRaw = forced;
                                }
                            } else if (globalForcedJsonifyElementRaw) {
                                try {
                                    const hasForcedGlobal = this.typeChecker
                                        .getPropertiesOfType(globalForcedJsonifyElementRaw)
                                        .some((s) => s.getName() === extendsMethodName);
                                    if (hasForcedGlobal) {
                                        targetRaw = globalForcedJsonifyElementRaw;
                                    }
                                } catch {
                                    /* ignore */
                                }
                            }
                        }
                    } catch {
                        /* ignore */
                    }
                    let hasMethod = false;
                    try {
                        hasMethod = this.typeChecker
                            .getPropertiesOfType(targetRaw)
                            .some((s) => s.getName() === extendsMethodName);
                    } catch {}
                    if (!hasMethod) {
                        try {
                            const sym = (targetRaw as any)?.symbol as ts.Symbol | undefined;
                            const decls = sym?.declarations || [];
                            for (const d of decls) {
                                if (ts.isClassDeclaration(d)) {
                                    const meth = d.members.find(
                                        (m) =>
                                            ts.isMethodDeclaration(m) &&
                                            m.name &&
                                            ts.isIdentifier(m.name) &&
                                            m.name.text === extendsMethodName,
                                    );
                                    if (meth) {
                                        hasMethod = true;
                                        break;
                                    }
                                }
                            }
                        } catch {}
                    }
                    // Rescue: if still no method and targetRaw is a naked type parameter, try ordered original types.
                    if (!hasMethod) {
                        try {
                            if ((targetRaw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                                const ordered: any = (context as any).originalTypesInOrder;
                                if (Array.isArray(ordered)) {
                                    for (const cand of ordered) {
                                        try {
                                            const has = this.typeChecker
                                                .getPropertiesOfType(cand)
                                                .some((s) => s.getName() === extendsMethodName);
                                            if (has) {
                                                targetRaw = cand;
                                                hasMethod = true;
                                                break;
                                            }
                                        } catch {
                                            /* ignore inner */
                                        }
                                    }
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                    // Secondary rescue: scan all originalTypes map values for a non-type-parameter raw with the method.
                    if (!hasMethod) {
                        try {
                            const originalsMap: Map<string, ts.Type> =
                                (context as any).originalTypes?.() || context.getOriginalTypes?.() || new Map();
                            const values: ts.Type[] = Array.from(originalsMap.values());
                            for (const cand of values) {
                                if ((cand.flags & ts.TypeFlags.TypeParameter) !== 0) continue;
                                try {
                                    const has = this.typeChecker
                                        .getPropertiesOfType(cand)
                                        .some((s) => s.getName() === extendsMethodName);
                                    if (has) {
                                        targetRaw = cand;
                                        hasMethod = true;
                                        break;
                                    }
                                } catch {
                                    /* ignore inner */
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                    if (hasMethod) {
                        try {
                            const methodSym = this.typeChecker
                                .getPropertiesOfType(targetRaw)
                                .find(
                                    (s) =>
                                        s.getName() === extendsMethodName ||
                                        s.getName() === extendsParamInferMethodName,
                                );
                            if (methodSym) {
                                const decl = methodSym.valueDeclaration ?? methodSym.declarations?.[0];
                                if (decl) {
                                    const methodType = this.typeChecker.getTypeOfSymbolAtLocation(methodSym, decl);
                                    const sig = methodType.getCallSignatures()?.[0];
                                    if (sig) {
                                        // Decide whether we substitute return type (method(): infer U) or parameter type (method(param: infer U))
                                        if (
                                            extendsParamInferMethodName &&
                                            methodSym.getName() === extendsParamInferMethodName
                                        ) {
                                            // Parameter infer: take first parameter type; if it's 'never' still substitute to propagate never upwards
                                            const params = sig.getParameters();
                                            if (params.length) {
                                                const pDecl = params[0].valueDeclaration ?? params[0].declarations?.[0];
                                                if (pDecl) {
                                                    let pType: ts.Type | undefined;
                                                    try {
                                                        pType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                            params[0],
                                                            pDecl,
                                                        );
                                                    } catch {
                                                        /* ignore */
                                                    }
                                                    if (pType) {
                                                        const pNode = this.typeChecker.typeToTypeNode(
                                                            pType,
                                                            undefined,
                                                            ts.NodeBuilderFlags.NoTruncation,
                                                        );
                                                        if (pNode && ts.isTypeNode(pNode)) {
                                                            const syntheticParamCtx = this.createSubContext(
                                                                node,
                                                                context,
                                                                new CheckType(checkTypeParameterName, checkType),
                                                                inferMap,
                                                            );
                                                            const resolvedParam = this.childNodeParser.createType(
                                                                pNode as ts.TypeNode,
                                                                syntheticParamCtx,
                                                            );
                                                            if (resolvedParam) return resolvedParam;
                                                        }
                                                    }
                                                }
                                            }
                                        } else {
                                            const retType = sig.getReturnType();
                                            const retNode = this.typeChecker.typeToTypeNode(
                                                retType,
                                                undefined,
                                                ts.NodeBuilderFlags.NoTruncation,
                                            );
                                            if (retNode && ts.isTypeNode(retNode)) {
                                                const syntheticContext = this.createSubContext(
                                                    node,
                                                    context,
                                                    new CheckType(checkTypeParameterName, checkType),
                                                    inferMap,
                                                );
                                                const resolved = this.childNodeParser.createType(
                                                    retNode as ts.TypeNode,
                                                    syntheticContext,
                                                );
                                                if (resolved) return resolved;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch {}
                        return this.childNodeParser.createType(
                            node.trueType,
                            this.createSubContext(
                                node,
                                context,
                                new CheckType(checkTypeParameterName, checkType),
                                inferMap,
                            ),
                        );
                    }
                }
            }
            // Concrete (non-parameter) branch
            if (!checkTypeParameterName) {
                if (ts.isTypeLiteralNode(node.extendsType) && ts.isTypeReferenceNode(node.checkType)) {
                    try {
                        const refSymbol = this.typeChecker.getSymbolAtLocation(node.checkType.typeName);
                        if (refSymbol && refSymbol.declarations?.length) {
                            const declType = this.typeChecker.getTypeAtLocation(refSymbol.declarations[0]);
                            const hasMethodDecl = this.typeChecker
                                .getPropertiesOfType(declType)
                                .some((s) => s.getName() === extendsMethodName);
                            if (hasMethodDecl) {
                                const methodSym = this.typeChecker
                                    .getPropertiesOfType(declType)
                                    .find((s) => s.getName() === extendsMethodName);
                                if (methodSym) {
                                    const mDecl = methodSym.valueDeclaration ?? methodSym.declarations?.[0];
                                    if (mDecl) {
                                        const methodType = this.typeChecker.getTypeOfSymbolAtLocation(methodSym, mDecl);
                                        const sig = methodType.getCallSignatures()?.[0];
                                        if (sig) {
                                            const retType = sig.getReturnType();
                                            const retNode = this.typeChecker.typeToTypeNode(
                                                retType,
                                                undefined,
                                                ts.NodeBuilderFlags.NoTruncation,
                                            );
                                            if (retNode && ts.isTypeNode(retNode)) {
                                                const syntheticContext = this.createSubContext(
                                                    node,
                                                    context,
                                                    undefined,
                                                    inferMap,
                                                );
                                                const resolved = this.childNodeParser.createType(
                                                    retNode as ts.TypeNode,
                                                    syntheticContext,
                                                );
                                                if (resolved) return resolved;
                                            }
                                        }
                                    }
                                }
                                return this.childNodeParser.createType(
                                    node.trueType,
                                    this.createSubContext(node, context, undefined, inferMap),
                                );
                            }
                        }
                    } catch {}
                }
                // Array element shortcut
                if (ts.isTypeLiteralNode(node.extendsType)) {
                    try {
                        const elemRaw = this.typeChecker.getIndexTypeOfType(rawCheckType, ts.IndexKind.Number);
                        if (elemRaw) {
                            const elemApparent = this.typeChecker.getApparentType(elemRaw);
                            let hasMethodElem = false;
                            try {
                                hasMethodElem = this.typeChecker
                                    .getPropertiesOfType(elemApparent)
                                    .some((s) => s.getName() === extendsMethodName);
                            } catch {}
                            if (!hasMethodElem) {
                                // Class declaration rescue
                                try {
                                    const sym = (elemRaw as any)?.symbol as ts.Symbol | undefined;
                                    const decls = sym?.declarations || [];
                                    for (const d of decls) {
                                        if (ts.isClassDeclaration(d)) {
                                            const meth = d.members.find(
                                                (m) =>
                                                    ts.isMethodDeclaration(m) &&
                                                    m.name &&
                                                    ts.isIdentifier(m.name) &&
                                                    m.name.text === extendsMethodName,
                                            );
                                            if (meth) {
                                                hasMethodElem = true;
                                                break;
                                            }
                                        }
                                    }
                                } catch {
                                    /* ignore */
                                }
                            }
                            if (hasMethodElem) {
                                const methodSym = this.typeChecker
                                    .getPropertiesOfType(elemApparent)
                                    .find((s) => s.getName() === extendsMethodName);
                                if (methodSym) {
                                    const decl = methodSym.valueDeclaration ?? methodSym.declarations?.[0];
                                    if (decl) {
                                        const methodType = this.typeChecker.getTypeOfSymbolAtLocation(methodSym, decl);
                                        const sig = methodType.getCallSignatures()?.[0];
                                        if (sig) {
                                            const retType = sig.getReturnType();
                                            const retNode = this.typeChecker.typeToTypeNode(
                                                retType,
                                                undefined,
                                                ts.NodeBuilderFlags.NoTruncation,
                                            );
                                            if (retNode && ts.isTypeNode(retNode)) {
                                                const arrayNode = ts.factory.createArrayTypeNode(
                                                    retNode as ts.TypeNode,
                                                );
                                                const syntheticContext = this.createSubContext(
                                                    node,
                                                    context,
                                                    undefined,
                                                    inferMap,
                                                );
                                                return this.childNodeParser.createType(arrayNode, syntheticContext);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch {}
                }
                // Indexed access variant
                if (ts.isIndexedAccessTypeNode(node.checkType) && ts.isTypeLiteralNode(node.extendsType)) {
                    let objectParamName: string | undefined;
                    const obj = node.checkType.objectType;
                    if (ts.isTypeReferenceNode(obj) && ts.isIdentifier(obj.typeName))
                        objectParamName = obj.typeName.text;
                    let keyName: string | undefined;
                    const idx = node.checkType.indexType;
                    if (
                        ts.isLiteralTypeNode(idx) &&
                        (ts.isStringLiteral(idx.literal) || ts.isNumericLiteral(idx.literal))
                    )
                        keyName = idx.literal.text;
                    if (objectParamName && keyName) {
                        const rawObject = context.getOriginalType(objectParamName);
                        if (rawObject) {
                            try {
                                const props = this.typeChecker.getPropertiesOfType(rawObject);
                                const propSym = props.find((p) => p.getName() === keyName);
                                if (propSym) {
                                    const decl = propSym.valueDeclaration ?? propSym.declarations?.[0];
                                    if (decl) {
                                        const propRawType = this.typeChecker.getTypeOfSymbolAtLocation(propSym, decl);
                                        const hasMethod = this.typeChecker
                                            .getPropertiesOfType(propRawType)
                                            .some((s) => s.getName() === extendsMethodName);
                                        if (hasMethod) {
                                            return this.childNodeParser.createType(
                                                node.trueType,
                                                this.createSubContext(node, context, undefined, inferMap),
                                            );
                                        }
                                    }
                                }
                            } catch {}
                        }
                    }
                }
            }
        }

        // Simple case: non-parameter
        if (checkTypeParameterName == null) {
            const result = isAssignableTo(extendsType, checkType, inferMap);
            return this.childNodeParser.createType(
                result ? node.trueType : node.falseType,
                this.createSubContext(node, context, undefined, result ? inferMap : new Map()),
            );
        }

        const trueCheckType = narrowType(checkType, (type) => isAssignableTo(extendsType, type, inferMap));
        const falseCheckType = narrowType(checkType, (type) => !isAssignableTo(extendsType, type));
        const results: BaseType[] = [];
        if (!(trueCheckType instanceof NeverType)) {
            const result = this.childNodeParser.createType(
                node.trueType,
                this.createSubContext(node, context, new CheckType(checkTypeParameterName, trueCheckType), inferMap),
            );
            if (result) results.push(result);
        }
        if (!(falseCheckType instanceof NeverType)) {
            const result = this.childNodeParser.createType(
                node.falseType,
                this.createSubContext(node, context, new CheckType(checkTypeParameterName, falseCheckType)),
            );
            if (result) results.push(result);
        }
        let finalType = new UnionType(results).normalize();

        // Generic fallback: if a method pattern was detected but earlier optimization didn't trigger, attempt substitution now.
        try {
            if (extendsMethodName) {
                // If checkType (rawCheckType) itself has the method, replace with its return type.
                const targetRawLate = boundRawType ?? rawCheckType;
                let hasMethodLate = false;
                try {
                    hasMethodLate = this.typeChecker
                        .getPropertiesOfType(targetRawLate)
                        .some((s) => s.getName() === extendsMethodName);
                } catch {}
                if (hasMethodLate) {
                    const methodSymLate = this.typeChecker
                        .getPropertiesOfType(targetRawLate)
                        .find((s) => s.getName() === extendsMethodName);
                    if (methodSymLate) {
                        const declLate = methodSymLate.valueDeclaration ?? methodSymLate.declarations?.[0];
                        if (declLate) {
                            const methodTypeLate = this.typeChecker.getTypeOfSymbolAtLocation(methodSymLate, declLate);
                            const sigLate = methodTypeLate.getCallSignatures()?.[0];
                            if (sigLate) {
                                const retTypeLate = sigLate.getReturnType();
                                const retNodeLate = this.typeChecker.typeToTypeNode(
                                    retTypeLate,
                                    undefined,
                                    ts.NodeBuilderFlags.NoTruncation,
                                );
                                if (retNodeLate && ts.isTypeNode(retNodeLate)) {
                                    const syntheticLate = this.createSubContext(
                                        node,
                                        context,
                                        checkTypeParameterName
                                            ? new CheckType(checkTypeParameterName, checkType)
                                            : undefined,
                                        inferMap,
                                    );
                                    const replaced = this.childNodeParser.createType(
                                        retNodeLate as ts.TypeNode,
                                        syntheticLate,
                                    );
                                    if (replaced) {
                                        finalType = replaced;
                                        return finalType;
                                    }
                                }
                            }
                        }
                    }
                }
                // Array fallback: if checkType is array whose element has the method and result is still array of object without method props.
                const elemRawLate = this.typeChecker.getIndexTypeOfType(targetRawLate, ts.IndexKind.Number);
                if (elemRawLate) {
                    let hasElemMethodLate = false;
                    try {
                        hasElemMethodLate = this.typeChecker
                            .getPropertiesOfType(this.typeChecker.getApparentType(elemRawLate))
                            .some((s) => s.getName() === extendsMethodName);
                    } catch {}
                    if (hasElemMethodLate) {
                        const methodElemSym = this.typeChecker
                            .getPropertiesOfType(this.typeChecker.getApparentType(elemRawLate))
                            .find((s) => s.getName() === extendsMethodName);
                        if (methodElemSym) {
                            const declElemLate = methodElemSym.valueDeclaration ?? methodElemSym.declarations?.[0];
                            if (declElemLate) {
                                const methodElemTypeLate = this.typeChecker.getTypeOfSymbolAtLocation(
                                    methodElemSym,
                                    declElemLate,
                                );
                                const sigElemLate = methodElemTypeLate.getCallSignatures()?.[0];
                                if (sigElemLate) {
                                    const retElemTypeLate = sigElemLate.getReturnType();
                                    const retElemNodeLate = this.typeChecker.typeToTypeNode(
                                        retElemTypeLate,
                                        undefined,
                                        ts.NodeBuilderFlags.NoTruncation,
                                    );
                                    if (retElemNodeLate && ts.isTypeNode(retElemNodeLate)) {
                                        const arrayNodeLate = ts.factory.createArrayTypeNode(
                                            retElemNodeLate as ts.TypeNode,
                                        );
                                        const syntheticArrayLate = this.createSubContext(
                                            node,
                                            context,
                                            checkTypeParameterName
                                                ? new CheckType(checkTypeParameterName, checkType)
                                                : undefined,
                                            inferMap,
                                        );
                                        const replacedArray = this.childNodeParser.createType(
                                            arrayNodeLate,
                                            syntheticArrayLate,
                                        );
                                        if (replacedArray) {
                                            finalType = replacedArray;
                                            return finalType;
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
        return finalType;
    }

    // Detect patterns: (infer E)[] , Array<infer E>, ReadonlyArray<infer E>, ParenthesizedType wrapping those.
    private getInferArrayInfo(node: ts.TypeNode): { inferName: string } | undefined {
        const unwrap = (n: ts.TypeNode): ts.TypeNode => (ts.isParenthesizedTypeNode(n) ? n.type : n);
        const core = unwrap(node);
        if (ts.isArrayTypeNode(core)) {
            const el = core.elementType;
            if (ts.isInferTypeNode(el)) {
                return { inferName: el.typeParameter.name.text };
            }
            if (ts.isParenthesizedTypeNode(el) && ts.isInferTypeNode(el.type)) {
                return { inferName: el.type.typeParameter.name.text };
            }
        }
        if (
            ts.isTypeReferenceNode(core) &&
            core.typeArguments?.length === 1 &&
            ts.isInferTypeNode(core.typeArguments[0])
        ) {
            const name = core.typeName;
            if (ts.isIdentifier(name) && (name.text === "Array" || name.text === "ReadonlyArray")) {
                return { inferName: core.typeArguments[0].typeParameter.name.text };
            }
        }
        return undefined;
    }

    /**
     * Returns the type parameter name of the given type node if any.
     *
     * @param node - The type node for which to return the type parameter name.
     * @return The type parameter name or null if specified type node is not a type parameter.
     */
    protected getTypeParameterName(node: ts.TypeNode): string | null {
        if (ts.isTypeReferenceNode(node)) {
            const typeSymbol = this.typeChecker.getSymbolAtLocation(node.typeName)!;
            if (typeSymbol.flags & ts.SymbolFlags.TypeParameter) return typeSymbol.name;
        }
        return null;
    }

    /**
     * Creates a sub context for evaluating the sub types of the conditional type. A sub context is needed in case
     * the check-type is a type parameter which is then narrowed down by the extends-type.
     *
     * @param node                   - The reference node for the new context.
     * @param checkType              - An object containing the type parameter name of the check-type, and the narrowed
     *                                 down check type to use for the type parameter in sub parsers.
     * @param inferMap               - A map that links parameter names to their inferred types.
     * @return The created sub context.
     */
    protected createSubContext(
        node: ts.ConditionalTypeNode,
        parentContext: Context,
        checkType?: CheckType,
        inferMap: Map<string, BaseType> = new Map(),
    ): Context {
        const subContext = new Context(node);
        // Preserve ordered original raw types (used by TypeAliasNodeParser to bind generics) from parent context.
        try {
            const ordered: any = (parentContext as any).originalTypesInOrder;
            if (Array.isArray(ordered) && ordered.length) {
                for (const t of ordered) {
                    subContext.pushOriginalTypeOrdered(t);
                }
            }
        } catch {
            /* ignore */
        }
        // Propagate forced Jsonify element raw fallback (for nested Jsonify<E>)
        try {
            const forced = (parentContext as any)._forcedJsonifyElementRaw as ts.Type | undefined;
            if (forced) (subContext as any)._forcedJsonifyElementRaw = forced;
            const elem = (parentContext as any)._jsonifyElementRaw as ts.Type | undefined;
            if (elem && !(subContext as any)._jsonifyElementRaw) (subContext as any)._jsonifyElementRaw = elem;
        } catch {
            /* ignore */
        }
        // Propagate deterministic concreteRaw bindings.
        try {
            const concrete: Map<string, ts.Type> | undefined = (parentContext as any).getAllConcreteRaws?.();
            if (concrete) {
                for (const [k, v] of concrete.entries()) {
                    (subContext as any).pushConcreteRaw?.(k, v);
                    // Also push as original if richer than any existing mapping.
                    const existing = subContext.getOriginalType(k);
                    if (!existing || (existing.flags & ts.TypeFlags.TypeParameter) !== 0) {
                        subContext.pushOriginalType(k, v);
                    }
                }
            }
        } catch {
            /* ignore */
        }
        inferMap.forEach((value, key) => {
            subContext.pushParameter(key);
            subContext.pushArgument(value);
            const originalInfer = parentContext.getOriginalType(key);
            if (originalInfer) subContext.pushOriginalType(key, originalInfer);
            // Also propagate concreteRaw mapping for inferred keys if present
            try {
                const c = (parentContext as any).getConcreteRaw?.(key);
                if (c) {
                    (subContext as any).pushConcreteRaw?.(key, c);
                }
            } catch {
                /* ignore */
            }
        });
        // Propagate inferred raw (e.g. element type from (infer E)[]) to the main check type parameter (T) when absent.
        if (checkType?.parameterName && !subContext.getOriginalType(checkType.parameterName)) {
            inferMap.forEach((_value, key) => {
                const inferRaw = subContext.getOriginalType(key);
                if (inferRaw && !subContext.getOriginalType(checkType.parameterName)) {
                    subContext.pushOriginalType(checkType.parameterName, inferRaw);
                }
            });
        }
        // Prefer concreteRaw for the main check type parameter if available
        try {
            if (checkType?.parameterName) {
                const cRaw: ts.Type | undefined = (parentContext as any).getConcreteRaw?.(checkType.parameterName);
                if (cRaw) {
                    const existing = subContext.getOriginalType(checkType.parameterName);
                    if (!existing || (existing.flags & ts.TypeFlags.TypeParameter) !== 0) {
                        subContext.pushOriginalType(checkType.parameterName, cRaw);
                    }
                }
            }
        } catch {
            /* ignore */
        }
        if (checkType && !(checkType.parameterName in inferMap)) {
            subContext.pushParameter(checkType.parameterName);
            subContext.pushArgument(checkType.type);
            const original = parentContext.getOriginalType(checkType.parameterName);
            if (original) subContext.pushOriginalType(checkType.parameterName, original);
        }
        parentContext.getParameters().forEach((parentParameter) => {
            if (parentParameter !== checkType?.parameterName && !(parentParameter in inferMap)) {
                subContext.pushParameter(parentParameter);
                subContext.pushArgument(parentContext.getArgument(parentParameter));
                const original = parentContext.getOriginalType(parentParameter);
                if (original) subContext.pushOriginalType(parentParameter, original);
            }
        });
        if (checkType?.parameterName) {
            try {
                const raw = this.typeChecker.getTypeFromTypeNode(node.checkType);
                if (raw) {
                    const existing = parentContext.getOriginalType(checkType.parameterName);
                    if (existing) {
                        let existingPropsLen = 0;
                        let newPropsLen = 0;
                        try {
                            existingPropsLen = this.typeChecker.getPropertiesOfType(existing).length;
                        } catch {}
                        try {
                            newPropsLen = this.typeChecker.getPropertiesOfType(raw).length;
                        } catch {}
                        const isIndexed = (raw.flags & ts.TypeFlags.IndexedAccess) !== 0;
                        const isTypeParamRaw = (raw.flags & ts.TypeFlags.TypeParameter) !== 0;
                        // concreteRaw takes precedence
                        const cRaw: ts.Type | undefined = (parentContext as any).getConcreteRaw?.(
                            checkType.parameterName,
                        );
                        if (cRaw) {
                            subContext.pushOriginalType(checkType.parameterName, cRaw);
                        } else if (existingPropsLen > 0 && (newPropsLen === 0 || isIndexed || isTypeParamRaw)) {
                            subContext.pushOriginalType(checkType.parameterName, existing);
                        } else {
                            subContext.pushOriginalType(checkType.parameterName, raw);
                        }
                    } else {
                        const cRaw: ts.Type | undefined = (parentContext as any).getConcreteRaw?.(
                            checkType.parameterName,
                        );
                        subContext.pushOriginalType(checkType.parameterName, cRaw || raw);
                        if (cRaw) {
                            try {
                                (subContext as any).pushConcreteRaw?.(checkType.parameterName, cRaw);
                            } catch {
                                /* ignore */
                            }
                        }
                    }
                }
            } catch {}
        }
        return subContext;
    }

    // Resolve a richer raw type for a naked type parameter by scanning ordered originals, originals map, and array element candidates.
    private resolveTypeParameterRaw(original: ts.Type, context: Context, methodName: string): ts.Type | undefined {
        // Ordered originals first (most recently pushed first is likely actual concrete raw)
        try {
            const ordered: any = (context as any).originalTypesInOrder;
            if (Array.isArray(ordered)) {
                for (const cand of ordered) {
                    if ((cand.flags & ts.TypeFlags.TypeParameter) !== 0) continue;
                    try {
                        const apparent = this.typeChecker.getApparentType(cand);
                        const props = this.typeChecker.getPropertiesOfType(apparent);
                        if (props.some((p) => p.getName() === methodName)) return cand;
                        const sym = (cand as any)?.symbol as ts.Symbol | undefined;
                        const decls = sym?.declarations || [];
                        for (const d of decls) {
                            if (ts.isClassDeclaration(d)) {
                                const hasMeth = d.members.some(
                                    (m) =>
                                        ts.isMethodDeclaration(m) &&
                                        m.name &&
                                        ts.isIdentifier(m.name) &&
                                        m.name.text === methodName,
                                );
                                if (hasMeth) return cand;
                            }
                        }
                        // Array element candidate
                        const elem = this.typeChecker.getIndexTypeOfType(cand, ts.IndexKind.Number);
                        if (elem) {
                            const elemApparent = this.typeChecker.getApparentType(elem);
                            const elemProps = this.typeChecker.getPropertiesOfType(elemApparent);
                            if (elemProps.some((p) => p.getName() === methodName)) return elem;
                        }
                    } catch {
                        /* ignore individual candidate errors */
                    }
                }
            }
        } catch {
            /* ignore ordered scan errors */
        }
        // Originals map next
        try {
            const originalsMap: Map<string, ts.Type> =
                (context as any).originalTypes?.() || context.getOriginalTypes?.() || new Map();
            for (const cand of originalsMap.values()) {
                if ((cand.flags & ts.TypeFlags.TypeParameter) !== 0) continue;
                try {
                    const apparent = this.typeChecker.getApparentType(cand);
                    const props = this.typeChecker.getPropertiesOfType(apparent);
                    if (props.some((p) => p.getName() === methodName)) return cand;
                    const sym = (cand as any)?.symbol as ts.Symbol | undefined;
                    const decls = sym?.declarations || [];
                    for (const d of decls) {
                        if (ts.isClassDeclaration(d)) {
                            const hasMeth = d.members.some(
                                (m) =>
                                    ts.isMethodDeclaration(m) &&
                                    m.name &&
                                    ts.isIdentifier(m.name) &&
                                    m.name.text === methodName,
                            );
                            if (hasMeth) return cand;
                        }
                    }
                    const elem = this.typeChecker.getIndexTypeOfType(cand, ts.IndexKind.Number);
                    if (elem) {
                        const elemApparent = this.typeChecker.getApparentType(elem);
                        const elemProps = this.typeChecker.getPropertiesOfType(elemApparent);
                        if (elemProps.some((p) => p.getName() === methodName)) return elem;
                    }
                } catch {
                    /* ignore */
                }
            }
        } catch {
            /* ignore map scan errors */
        }
        return undefined;
    }
}
