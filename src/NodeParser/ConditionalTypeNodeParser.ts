import ts from "typescript";
// Debug helper (enable with TS_JSG_DEBUG=1)
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

/**
 * Helper: given a candidate type and a method name, attempts to obtain a stable TypeNode describing
 * the method return type. It prefers an explicit return type annotation from the method declaration
 * when that annotation is an object/union/intersection/reference/array so we keep literal structure.
 * Otherwise it resolves the signature, obtains the return ts.Type and (if object-like) rebuilds a
 * type literal enumerating its properties to avoid loss of members during typeToTypeNode reduction.
 */
function buildMethodReturnNode(
    typeChecker: ts.TypeChecker,
    candidate: ts.Type,
    methodName: string,
): { retNode?: ts.TypeNode; methodDecl?: ts.MethodDeclaration } | undefined {
    let methodSym: ts.Symbol | undefined;
    try {
        methodSym = typeChecker.getPropertiesOfType(candidate).find((s) => s.getName() === methodName);
    } catch {
        /* ignore */
    }
    let decl: ts.Declaration | undefined;
    if (!methodSym) {
        // Class declaration rescue: scan declarations for method symbol manually (prototype not on apparent type)
        try {
            const sym = (candidate as any).symbol as ts.Symbol | undefined;
            const decls = sym?.declarations || [];
            for (const d of decls) {
                if (ts.isClassDeclaration(d)) {
                    const m = d.members.find(
                        (mm) =>
                            ts.isMethodDeclaration(mm) &&
                            mm.name &&
                            ts.isIdentifier(mm.name) &&
                            mm.name.text === methodName,
                    );
                    if (m) {
                        decl = m;
                        // Acquire symbol through class type for consistency
                        try {
                            const clsType = typeChecker.getTypeAtLocation(d);
                            methodSym = typeChecker
                                .getPropertiesOfType(clsType)
                                .find((p) => p.getName() === methodName);
                        } catch {
                            /* ignore */
                        }
                        break;
                    }
                }
            }
        } catch {
            /* ignore */
        }
    } else {
        decl = methodSym.valueDeclaration ?? methodSym.declarations?.[0];
    }
    if (!methodSym || !decl) return undefined;

    // Prefer explicit return annotation when structurally rich
    if (ts.isMethodDeclaration(decl) && decl.type) {
        const rt = decl.type;
        if (
            ts.isTypeLiteralNode(rt) ||
            ts.isUnionTypeNode(rt) ||
            ts.isIntersectionTypeNode(rt) ||
            ts.isTypeReferenceNode(rt) ||
            ts.isArrayTypeNode(rt)
        ) {
            return { retNode: rt as ts.TypeNode, methodDecl: decl };
        }
    }
    // Fallback to signature evaluation
    try {
        const methodType = typeChecker.getTypeOfSymbolAtLocation(methodSym, decl);
        const sig = methodType.getCallSignatures()?.[0];
        if (!sig) return undefined;
        const retType = sig.getReturnType();
        // Rebuild literal from properties if any
        let rebuilt: ts.TypeNode | undefined;
        try {
            const props = typeChecker.getPropertiesOfType(retType);
            if (props.length) {
                const members: ts.TypeElement[] = [];
                for (const p of props) {
                    const pDecl = p.valueDeclaration ?? p.declarations?.[0];
                    let pType: ts.Type | undefined;
                    try {
                        pType = typeChecker.getTypeOfSymbolAtLocation(p, pDecl ?? decl);
                    } catch {
                        /* ignore */
                    }
                    const pTypeNode = pType
                        ? typeChecker.typeToTypeNode(pType, undefined, ts.NodeBuilderFlags.NoTruncation)
                        : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
                    members.push(
                        ts.factory.createPropertySignature(
                            undefined,
                            p.getName() === "__proto__"
                                ? ts.factory.createIdentifier("__proto__")
                                : ts.factory.createIdentifier(p.getName()),
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
        const retNode = rebuilt || typeChecker.typeToTypeNode(retType, undefined, ts.NodeBuilderFlags.NoTruncation);
        if (retNode && ts.isTypeNode(retNode)) return { retNode: retNode as ts.TypeNode };
    } catch {
        /* ignore */
    }
    return undefined;
}

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

        let rawCheckType = boundRawType ?? this.typeChecker.getTypeFromTypeNode(node.checkType);
        // If the resolved rawCheckType is still a naked type parameter (e.g. 'E' from earlier 'infer E')
        // attempt to lift its original (enriched) raw type from context so that method symbols (toJSON, etc.)
        // are visible to subsequent method-pattern inference. This is pure abstraction (no alias name checks) and
        // only replaces the check type when we can locate a concrete original for the type parameter.
        try {
            if (rawCheckType && (rawCheckType.flags & ts.TypeFlags.TypeParameter) !== 0) {
                const sym = (rawCheckType as any).symbol as ts.Symbol | undefined;
                const paramName = sym?.getName();
                if (paramName) {
                    const enriched = context.getOriginalType(paramName);
                    if (enriched && enriched !== rawCheckType) {
                        // Prefer enriched only if it actually has at least one method member (heuristic to avoid pointless swaps)
                        try {
                            const hasMethod = this.typeChecker
                                .getPropertiesOfType(enriched)
                                .some((p) => (p.getFlags() & ts.SymbolFlags.Method) !== 0);
                            if (hasMethod) {
                                rawCheckType = enriched;
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
                        // Attempt to enrich element raw with its declared class type (to preserve methods like toJSON)
                        let enrichedElemRaw: ts.Type = elemRawUniversal;
                        try {
                            const sym = (elemRawUniversal as any).symbol as ts.Symbol | undefined;
                            const decls = sym?.declarations || [];
                            const classDecl = decls.find((d: ts.Declaration) => ts.isClassDeclaration(d)) as
                                | ts.ClassDeclaration
                                | undefined;
                            if (classDecl) {
                                const classType = this.typeChecker.getTypeAtLocation(classDecl);
                                // Prefer classType if it actually has methods (e.g. toJSON)
                                const hasMethod = this.typeChecker
                                    .getPropertiesOfType(classType)
                                    .some((p) => p.getName() === "toJSON");
                                if (hasMethod) {
                                    enrichedElemRaw = classType;
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                        // Decide whether to overwrite existing original based on method presence
                        const existing = context.getOriginalType(inferName);
                        let existingHasMethod = false;
                        if (existing) {
                            try {
                                existingHasMethod = this.typeChecker
                                    .getPropertiesOfType(existing)
                                    .some((p) => p.getName() === "toJSON");
                            } catch {
                                /* ignore */
                            }
                        }
                        const enrichedHasMethod = (() => {
                            try {
                                return this.typeChecker
                                    .getPropertiesOfType(enrichedElemRaw)
                                    .some((p) => p.getName() === "toJSON");
                            } catch {
                                return false;
                            }
                        })();
                        if (!existing || (enrichedHasMethod && !existingHasMethod)) {
                            context.pushOriginalType(inferName, enrichedElemRaw);
                        }
                        try {
                            (context as any).pushConcreteRaw?.(inferName, enrichedElemRaw);
                        } catch {
                            /* ignore */
                        }
                        // Provide fallbacks for later alias parsing rescues
                        try {
                            (context as any)._lastMethodElementRaw = enrichedElemRaw;
                            (globalThis as any).__lastMethodElementRaw = enrichedElemRaw;
                        } catch {
                            /* ignore */
                        }
                        try {
                            // Put enriched element raw at front of ordered originals for precedence
                            const list: ts.Type[] = (context as any).originalTypesInOrder || [];
                            if (!list.includes(enrichedElemRaw)) {
                                (context as any).originalTypesInOrder = [enrichedElemRaw, ...list];
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
                let elemRaw = this.typeChecker.getIndexTypeOfType(rawCheckType, ts.IndexKind.Number);
                if (elemRaw) {
                    // Enrich element raw similarly to universal block
                    try {
                        const sym = (elemRaw as any).symbol as ts.Symbol | undefined;
                        const decls = sym?.declarations || [];
                        const classDecl = decls.find((d: ts.Declaration) => ts.isClassDeclaration(d)) as
                            | ts.ClassDeclaration
                            | undefined;
                        if (classDecl) {
                            const classType = this.typeChecker.getTypeAtLocation(classDecl);
                            const hasMethod = this.typeChecker
                                .getPropertiesOfType(classType)
                                .some((p) => p.getName() === "toJSON");
                            if (hasMethod) {
                                elemRaw = classType;
                            }
                        }
                    } catch {
                        /* ignore */
                    }
                    // Produce TypeNode for element raw, bind inferName -> element base type in inferMap
                    let elemNode: ts.TypeNode | undefined = this.typeChecker.typeToTypeNode(
                        elemRaw,
                        undefined,
                        ts.NodeBuilderFlags.NoTruncation,
                    ) as ts.TypeNode | undefined;
                    // Build a synthetic minimal method-bearing literal if builder produced 'any' or failed.
                    try {
                        const elemAsString = this.typeChecker.typeToString(elemRaw);
                        const props = this.typeChecker.getPropertiesOfType(elemRaw);
                        const toJSONSym = props.find((p) => p.getName() === "toJSON");
                        if (toJSONSym) {
                            const decl = toJSONSym.valueDeclaration ?? toJSONSym.declarations?.[0];
                            if (decl) {
                                const methodType = this.typeChecker.getTypeOfSymbolAtLocation(toJSONSym, decl);
                                const sig = methodType.getCallSignatures()?.[0];
                                if (sig) {
                                    const retType = sig.getReturnType();
                                    let retNode = this.typeChecker.typeToTypeNode(
                                        retType,
                                        undefined,
                                        ts.NodeBuilderFlags.NoTruncation,
                                    ) as ts.TypeNode | undefined;
                                    if (!retNode || retNode.kind === ts.SyntaxKind.AnyKeyword) {
                                        // Rebuild object literal explicitly for stability
                                        try {
                                            const rprops = this.typeChecker.getPropertiesOfType(retType);
                                            if (rprops.length) {
                                                const members: ts.TypeElement[] = [];
                                                for (const rp of rprops) {
                                                    const rpDecl = rp.valueDeclaration ?? rp.declarations?.[0];
                                                    let rpType: ts.Type | undefined;
                                                    try {
                                                        rpType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                            rp,
                                                            rpDecl ?? decl,
                                                        );
                                                    } catch {
                                                        /* ignore */
                                                    }
                                                    const rpTypeNode = rpType
                                                        ? this.typeChecker.typeToTypeNode(
                                                              rpType,
                                                              undefined,
                                                              ts.NodeBuilderFlags.NoTruncation,
                                                          )
                                                        : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
                                                    members.push(
                                                        ts.factory.createPropertySignature(
                                                            undefined,
                                                            rp.getName(),
                                                            undefined,
                                                            rpTypeNode as ts.TypeNode,
                                                        ),
                                                    );
                                                }
                                                retNode = ts.factory.createTypeLiteralNode(members);
                                            }
                                        } catch {
                                            /* ignore */
                                        }
                                    }
                                    if (retNode) {
                                        const methodSig = ts.factory.createMethodSignature(
                                            undefined,
                                            "toJSON",
                                            undefined,
                                            undefined,
                                            [],
                                            retNode,
                                        );
                                        elemNode = ts.factory.createTypeLiteralNode([methodSig]);
                                        debugLog(
                                            "[debug elem synth]",
                                            elemAsString,
                                            "-> synthetic literal with toJSON",
                                        );
                                    }
                                }
                            }
                        }
                    } catch {
                        /* ignore */
                    }
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
                                            // Always promote alias parameter original raw to enriched element raw for recursive invocation.
                                            sub.pushOriginalType(aliasParamName, elemRaw);
                                            try {
                                                (sub as any).originalTypesInOrder = [
                                                    elemRaw,
                                                    ...((sub as any).originalTypesInOrder || []),
                                                ];
                                            } catch {
                                                /* ignore */
                                            }
                                            try {
                                                (sub as any).pushConcreteRaw?.(aliasParamName, elemRaw);
                                            } catch {
                                                /* ignore */
                                            }
                                            debugLog(
                                                "[debug promote recursive alias] param",
                                                aliasParamName,
                                                "-> element with methods",
                                            );
                                        }
                                    }
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                        // Substitute infer reference in recursive alias invocation: Jsonify<E>[] -> Jsonify<ElemRaw>[]
                        let substitutedTrue: ts.TypeNode = node.trueType;
                        try {
                            if (
                                ts.isArrayTypeNode(node.trueType) &&
                                ts.isTypeReferenceNode(node.trueType.elementType) &&
                                node.trueType.elementType.typeArguments?.length === 1 &&
                                elemNode &&
                                ts.isTypeNode(elemNode)
                            ) {
                                const targ = node.trueType.elementType.typeArguments[0];
                                if (
                                    ts.isTypeReferenceNode(targ) &&
                                    ts.isIdentifier(targ.typeName) &&
                                    targ.typeName.text === inferName
                                ) {
                                    const newRef = ts.factory.createTypeReferenceNode(
                                        node.trueType.elementType.typeName,
                                        [elemNode as ts.TypeNode],
                                    );
                                    substitutedTrue = ts.factory.createArrayTypeNode(newRef);
                                    debugLog(
                                        "[debug array infer] substituted Jsonify<infer> with concrete element type",
                                    );
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                        const trueResolved = this.childNodeParser.createType(substitutedTrue, sub);
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
        if (ts.isTypeLiteralNode(node.extendsType)) {
            for (const member of node.extendsType.members) {
                if (ts.isMethodSignature(member) && member.name && ts.isIdentifier(member.name)) {
                    const ret = member.type;
                    if (ret && ts.isInferTypeNode(ret)) {
                        extendsMethodName = member.name.text;
                        extendsInferName = ret.typeParameter.name.text;
                        debugLog("[debug detect] return-infer method=", extendsMethodName, "infer=", extendsInferName);
                        break; // prioritize return infer over param infer if both present
                    }
                    // Scan parameters for param: infer U pattern
                    if (!extendsMethodName && member.parameters) {
                        for (const p of member.parameters) {
                            if (p.type && ts.isInferTypeNode(p.type)) {
                                extendsParamInferMethodName = member.name.text;
                                debugLog("[debug detect] param-infer method=", extendsParamInferMethodName);
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
                debugLog("[debug detect] promote param-infer to method=", extendsMethodName);
            }
        } else {
            try {
                const extText = (node.extendsType as any).getText?.() || "<no-text>";
                if (extText.includes("toJSON")) {
                    // eslint-disable-next-line no-console
                    console.log(
                        "[debug conditional-tojson] extendsType not TypeLiteral; kind=",
                        node.extendsType.kind,
                        "text=",
                        extText.substring(0, 60),
                    );
                }
            } catch {
                /* ignore */
            }
        }

        if (rawCheckType && rawExtendsType && extendsMethodName) {
            // Early shortcut: array element possesses method → directly emit array of return type.
            try {
                const elemRawEarly = this.typeChecker.getIndexTypeOfType(rawCheckType, ts.IndexKind.Number);
                if (elemRawEarly) {
                    const built = buildMethodReturnNode(
                        this.typeChecker,
                        this.typeChecker.getApparentType(elemRawEarly),
                        extendsMethodName,
                    );
                    if (built?.retNode && ts.isTypeNode(built.retNode)) {
                        const arrayNodeEarly = ts.factory.createArrayTypeNode(built.retNode as ts.TypeNode);
                        const syntheticContextEarly = this.createSubContext(
                            node,
                            context,
                            checkTypeParameterName ? new CheckType(checkTypeParameterName, checkType) : undefined,
                            inferMap,
                        );
                        const earlyResolved = this.childNodeParser.createType(arrayNodeEarly, syntheticContextEarly);
                        if (earlyResolved) return earlyResolved;
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
                            // Fallback: use explicitly stored element raw from earlier array branch (Jsonify<E>[] scenario)
                            if ((targetRaw.flags & ts.TypeFlags.TypeParameter) !== 0) {
                                try {
                                    const elemFallback: ts.Type | undefined = (context as any)._lastMethodElementRaw;
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
                                        // Promote targetRaw to the concrete class type so subsequent getPropertiesOfType finds the method symbol
                                        try {
                                            const clsType = this.typeChecker.getTypeAtLocation(d);
                                            if (clsType) {
                                                targetRaw = clsType;
                                            }
                                        } catch {
                                            /* ignore */
                                        }
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
                            const originalsMap: Map<string, ts.Type> = (context as any).originalTypes?.() || new Map();
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
                            // Parameter infer path retained (rare) else use unified helper.
                            let handled = false;
                            if (extendsParamInferMethodName) {
                                // True parameter-infer pattern: '{ fromDto(param: infer U): any }'
                                // We must extract the FIRST parameter's instantiated type (after generic substitution)
                                // rather than the method return type. Returning that type directly fulfills the
                                // conditional true branch semantics (T extends { fromDto(param: infer U): any } ? U : T).
                                try {
                                    const methSym = this.typeChecker
                                        .getPropertiesOfType(targetRaw)
                                        .find((s) => s.getName() === extendsParamInferMethodName);
                                    if (methSym) {
                                        const mDecl = methSym.valueDeclaration ?? methSym.declarations?.[0];
                                        if (mDecl) {
                                            const mType = this.typeChecker.getTypeOfSymbolAtLocation(methSym, mDecl);
                                            const sig = mType.getCallSignatures()?.[0];
                                            if (sig) {
                                                const sigParams = sig.getParameters();
                                                if (sigParams.length) {
                                                    const firstParam = sigParams[0];
                                                    const pDecl =
                                                        firstParam.valueDeclaration ?? firstParam.declarations?.[0];
                                                    let pType: ts.Type | undefined;
                                                    try {
                                                        pType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                            firstParam,
                                                            pDecl ?? mDecl,
                                                        );
                                                    } catch {
                                                        /* ignore */
                                                    }
                                                    if (pType) {
                                                        // Build a stable TypeNode for parameter type; rebuild object literal if needed
                                                        let paramNode: ts.TypeNode | undefined =
                                                            this.typeChecker.typeToTypeNode(
                                                                pType,
                                                                undefined,
                                                                ts.NodeBuilderFlags.NoTruncation,
                                                            ) as ts.TypeNode | undefined;
                                                        if (
                                                            paramNode &&
                                                            paramNode.kind === ts.SyntaxKind.AnyKeyword &&
                                                            (pType.getFlags() & ts.TypeFlags.Object) !== 0
                                                        ) {
                                                            try {
                                                                const pProps =
                                                                    this.typeChecker.getPropertiesOfType(pType);
                                                                if (pProps.length) {
                                                                    const members: ts.TypeElement[] = [];
                                                                    for (const pp of pProps) {
                                                                        const ppDecl =
                                                                            pp.valueDeclaration ?? pp.declarations?.[0];
                                                                        let ppType: ts.Type | undefined;
                                                                        try {
                                                                            ppType =
                                                                                this.typeChecker.getTypeOfSymbolAtLocation(
                                                                                    pp,
                                                                                    ppDecl ?? mDecl,
                                                                                );
                                                                        } catch {
                                                                            /* ignore */
                                                                        }
                                                                        const ppTypeNode = ppType
                                                                            ? this.typeChecker.typeToTypeNode(
                                                                                  ppType,
                                                                                  undefined,
                                                                                  ts.NodeBuilderFlags.NoTruncation,
                                                                              )
                                                                            : ts.factory.createKeywordTypeNode(
                                                                                  ts.SyntaxKind.AnyKeyword,
                                                                              );
                                                                        members.push(
                                                                            ts.factory.createPropertySignature(
                                                                                undefined,
                                                                                pp.getName() === "__proto__"
                                                                                    ? ts.factory.createIdentifier(
                                                                                          "__proto__",
                                                                                      )
                                                                                    : ts.factory.createIdentifier(
                                                                                          pp.getName(),
                                                                                      ),
                                                                                undefined,
                                                                                ppTypeNode as ts.TypeNode,
                                                                            ),
                                                                        );
                                                                    }
                                                                    paramNode =
                                                                        ts.factory.createTypeLiteralNode(members);
                                                                }
                                                            } catch {
                                                                /* ignore */
                                                            }
                                                        }
                                                        if (paramNode && ts.isTypeNode(paramNode)) {
                                                            const syntheticContext = this.createSubContext(
                                                                node,
                                                                context,
                                                                new CheckType(checkTypeParameterName, checkType),
                                                                inferMap,
                                                            );
                                                            const resolvedParam = this.childNodeParser.createType(
                                                                paramNode as ts.TypeNode,
                                                                syntheticContext,
                                                            );
                                                            if (resolvedParam) {
                                                                // Mark handled so we don't fall back to return-type logic
                                                                handled = true;
                                                                return resolvedParam;
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
                            }
                            if (!handled) {
                                const built = buildMethodReturnNode(this.typeChecker, targetRaw, extendsMethodName);
                                if (built?.retNode && ts.isTypeNode(built.retNode)) {
                                    const syntheticContext = this.createSubContext(
                                        node,
                                        context,
                                        new CheckType(checkTypeParameterName, checkType),
                                        inferMap,
                                    );
                                    const resolved = this.childNodeParser.createType(
                                        built.retNode as ts.TypeNode,
                                        syntheticContext,
                                    );
                                    if (resolved) {
                                        if (extendsInferName && !inferMap.has(extendsInferName)) {
                                            inferMap.set(extendsInferName, resolved);
                                        }
                                        return resolved;
                                    }
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                        return this.childNodeParser.createType(
                            node.trueType,
                            this.createSubContext(
                                node,
                                context,
                                new CheckType(checkTypeParameterName, checkType),
                                inferMap,
                            ),
                        );
                    } else {
                        // (Removed debug logging branch)
                        // Final rescue fallback: attempt to derive method return type from any candidate types
                        // available in context (ordered originals, originalTypes map, element raw) even if direct
                        // property scan above failed to flip hasMethod. This covers cases where the raw type parameter
                        // loses its method symbol through intermediate conditional evaluation but its apparent type
                        // still exposes the method.
                        try {
                            if (extendsMethodName) {
                                const candidateSet: ts.Type[] = [];
                                try {
                                    if (targetRaw) candidateSet.push(targetRaw);
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    const ordered: any = (context as any).originalTypesInOrder;
                                    if (Array.isArray(ordered)) candidateSet.push(...ordered);
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    const originalsMap: Map<string, ts.Type> =
                                        (context as any).originalTypes?.() || new Map();
                                    candidateSet.push(...Array.from(originalsMap.values()));
                                } catch {
                                    /* ignore */
                                }
                                try {
                                    const elemFallback: ts.Type | undefined = (context as any)._lastMethodElementRaw;
                                    if (elemFallback) candidateSet.push(elemFallback);
                                } catch {
                                    /* ignore */
                                }
                                for (const cand of candidateSet) {
                                    let methodSym: ts.Symbol | undefined;
                                    try {
                                        const apparent = this.typeChecker.getApparentType(cand);
                                        methodSym = this.typeChecker
                                            .getPropertiesOfType(apparent)
                                            .find((s) => s.getName() === extendsMethodName);
                                    } catch {
                                        /* ignore */
                                    }
                                    if (!methodSym) continue;
                                    try {
                                        const decl = methodSym.valueDeclaration ?? methodSym.declarations?.[0];
                                        if (!decl) continue;
                                        const methodType = this.typeChecker.getTypeOfSymbolAtLocation(methodSym, decl);
                                        const sig = methodType.getCallSignatures()?.[0];
                                        if (!sig) continue;
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
                                                checkTypeParameterName
                                                    ? new CheckType(checkTypeParameterName, checkType)
                                                    : undefined,
                                                inferMap,
                                            );
                                            const resolved = this.childNodeParser.createType(
                                                retNode as ts.TypeNode,
                                                syntheticContext,
                                            );
                                            if (resolved) {
                                                if (extendsInferName && !inferMap.has(extendsInferName)) {
                                                    inferMap.set(extendsInferName, resolved);
                                                }
                                                return resolved;
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
                            try {
                                // eslint-disable-next-line no-console
                                console.log(
                                    "[debug early concrete] type=",
                                    node.checkType.typeName.getText(),
                                    "extendsMethodName=",
                                    extendsMethodName,
                                    "hasMethodDecl=",
                                    hasMethodDecl,
                                    "props=",
                                    this.typeChecker.getPropertiesOfType(declType).map((p) => p.getName()),
                                );
                            } catch {
                                /* ignore */
                            }
                            // (Removed concrete branch debug logging)
                            if (hasMethodDecl) {
                                const methodSym = this.typeChecker
                                    .getPropertiesOfType(declType)
                                    .find((s) => s.getName() === extendsMethodName);
                                if (methodSym) {
                                    const mDecl = methodSym.valueDeclaration ?? methodSym.declarations?.[0];
                                    if (mDecl) {
                                        // Concrete branch fallback: try explicit return type AST first for richer literal information.
                                        if (ts.isMethodDeclaration(mDecl) && mDecl.type) {
                                            const explicitRetNode = mDecl.type;
                                            if (
                                                ts.isTypeLiteralNode(explicitRetNode) ||
                                                ts.isUnionTypeNode(explicitRetNode) ||
                                                ts.isIntersectionTypeNode(explicitRetNode) ||
                                                ts.isTypeReferenceNode(explicitRetNode) ||
                                                ts.isArrayTypeNode(explicitRetNode)
                                            ) {
                                                try {
                                                    const explicitCtx = this.createSubContext(
                                                        node,
                                                        context,
                                                        undefined,
                                                        inferMap,
                                                    );
                                                    const explicitParsed = this.childNodeParser.createType(
                                                        explicitRetNode as ts.TypeNode,
                                                        explicitCtx,
                                                    );
                                                    if (explicitParsed) return explicitParsed;
                                                } catch {
                                                    /* ignore */
                                                }
                                            }
                                        }
                                        const methodType = this.typeChecker.getTypeOfSymbolAtLocation(methodSym, mDecl);
                                        const sig = methodType.getCallSignatures()?.[0];
                                        if (sig) {
                                            const retType = sig.getReturnType();
                                            // Rebuild a fresh type literal from properties to avoid losing inferred literal members (e.g. 'upper').
                                            let rebuiltRetNode: ts.TypeNode | undefined;
                                            try {
                                                const retProps = this.typeChecker.getPropertiesOfType(retType);
                                                if (retProps.length) {
                                                    const members: ts.TypeElement[] = [];
                                                    for (const p of retProps) {
                                                        const pDecl = p.valueDeclaration ?? p.declarations?.[0];
                                                        let pType: ts.Type | undefined;
                                                        try {
                                                            pType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                                p,
                                                                pDecl ?? mDecl,
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
                                                            : undefined;
                                                        members.push(
                                                            ts.factory.createPropertySignature(
                                                                undefined,
                                                                p.getName() === "__proto__"
                                                                    ? ts.factory.createIdentifier("__proto__")
                                                                    : ts.factory.createIdentifier(p.getName()),
                                                                undefined,
                                                                (pTypeNode as ts.TypeNode) ||
                                                                    ts.factory.createKeywordTypeNode(
                                                                        ts.SyntaxKind.AnyKeyword,
                                                                    ),
                                                            ),
                                                        );
                                                    }
                                                    rebuiltRetNode = ts.factory.createTypeLiteralNode(members);
                                                }
                                            } catch {
                                                /* ignore */
                                            }
                                            const retNode =
                                                rebuiltRetNode ||
                                                this.typeChecker.typeToTypeNode(
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
                                // (Removed fallback debug logging)
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
                                                const resolved = this.childNodeParser.createType(
                                                    arrayNode,
                                                    syntheticContext,
                                                );
                                                if (resolved && extendsInferName && !inferMap.has(extendsInferName)) {
                                                    inferMap.set(extendsInferName, resolved);
                                                }
                                                return resolved;
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
        // Generic concrete method inference: if extends pattern is a method with infer and rawCheckType (apparent) owns that method,
        // directly substitute with rebuilt method return type before falling back to assignability logic.
        try {
            if (checkTypeParameterName == null && extendsMethodName && ts.isTypeLiteralNode(node.extendsType)) {
                const baseRaw = boundRawType ?? rawCheckType;
                if (baseRaw) {
                    let hasMethodConcrete = false;
                    try {
                        hasMethodConcrete = this.typeChecker
                            .getPropertiesOfType(this.typeChecker.getApparentType(baseRaw))
                            .some((s) => s.getName() === extendsMethodName);
                    } catch {
                        /* ignore */
                    }
                    try {
                        // eslint-disable-next-line no-console
                        console.log(
                            "[debug conditional-tojson nested] extendsMethodName=",
                            extendsMethodName,
                            "baseRaw=",
                            this.typeChecker.typeToString(baseRaw),
                            "hasMethodConcrete=",
                            hasMethodConcrete,
                        );
                    } catch {
                        /* ignore */
                    }
                    if (hasMethodConcrete) {
                        try {
                            const methodSymConcrete = this.typeChecker
                                .getPropertiesOfType(this.typeChecker.getApparentType(baseRaw))
                                .find((s) => s.getName() === extendsMethodName);
                            const declConcrete =
                                methodSymConcrete?.valueDeclaration ?? methodSymConcrete?.declarations?.[0];
                            if (methodSymConcrete && declConcrete) {
                                const methodTypeConcrete = this.typeChecker.getTypeOfSymbolAtLocation(
                                    methodSymConcrete,
                                    declConcrete,
                                );
                                const sigConcrete = methodTypeConcrete.getCallSignatures()?.[0];
                                if (sigConcrete) {
                                    const retTypeConcrete = sigConcrete.getReturnType();
                                    // Rebuild literal
                                    let retLiteral: ts.TypeNode | undefined;
                                    try {
                                        const retProps = this.typeChecker.getPropertiesOfType(retTypeConcrete);
                                        if (retProps.length) {
                                            const members: ts.TypeElement[] = [];
                                            for (const p of retProps) {
                                                const pDecl = p.valueDeclaration ?? p.declarations?.[0];
                                                let pType: ts.Type | undefined;
                                                try {
                                                    pType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                        p,
                                                        pDecl ?? declConcrete,
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
                                                    : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
                                                members.push(
                                                    ts.factory.createPropertySignature(
                                                        undefined,
                                                        ts.factory.createIdentifier(p.getName()),
                                                        undefined,
                                                        pTypeNode as ts.TypeNode,
                                                    ),
                                                );
                                            }
                                            retLiteral = ts.factory.createTypeLiteralNode(members);
                                        }
                                    } catch {
                                        /* ignore */
                                    }
                                    const retNodeConcrete =
                                        retLiteral ||
                                        this.typeChecker.typeToTypeNode(
                                            retTypeConcrete,
                                            undefined,
                                            ts.NodeBuilderFlags.NoTruncation,
                                        );
                                    if (retNodeConcrete && ts.isTypeNode(retNodeConcrete)) {
                                        const syntheticCtxConcrete = this.createSubContext(
                                            node,
                                            context,
                                            undefined,
                                            inferMap,
                                        );
                                        const resolvedConcrete = this.childNodeParser.createType(
                                            retNodeConcrete as ts.TypeNode,
                                            syntheticCtxConcrete,
                                        );
                                        if (resolvedConcrete) return resolvedConcrete;
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
                                // Rebuild literal for late substitution
                                let rebuiltRetNodeLate: ts.TypeNode | undefined;
                                try {
                                    const retPropsLate = this.typeChecker.getPropertiesOfType(retTypeLate);
                                    if (retPropsLate.length) {
                                        const membersLate: ts.TypeElement[] = [];
                                        for (const p of retPropsLate) {
                                            const pDecl = p.valueDeclaration ?? p.declarations?.[0];
                                            let pType: ts.Type | undefined;
                                            try {
                                                pType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                    p,
                                                    pDecl || declLate,
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
                                                : undefined;
                                            membersLate.push(
                                                ts.factory.createPropertySignature(
                                                    undefined,
                                                    p.getName() === "__proto__"
                                                        ? ts.factory.createIdentifier("__proto__")
                                                        : ts.factory.createIdentifier(p.getName()),
                                                    undefined,
                                                    (pTypeNode as ts.TypeNode) ||
                                                        ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
                                                ),
                                            );
                                        }
                                        rebuiltRetNodeLate = ts.factory.createTypeLiteralNode(membersLate);
                                    }
                                } catch {
                                    /* ignore */
                                }
                                const retNodeLate =
                                    rebuiltRetNodeLate ||
                                    this.typeChecker.typeToTypeNode(
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
                                    // Rebuild literal for array element late substitution
                                    let rebuiltRetElemNodeLate: ts.TypeNode | undefined;
                                    try {
                                        const retElemPropsLate = this.typeChecker.getPropertiesOfType(retElemTypeLate);
                                        if (retElemPropsLate.length) {
                                            const membersElemLate: ts.TypeElement[] = [];
                                            for (const p of retElemPropsLate) {
                                                const pDecl = p.valueDeclaration ?? p.declarations?.[0];
                                                let pType: ts.Type | undefined;
                                                try {
                                                    pType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                        p,
                                                        pDecl || declElemLate,
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
                                                    : undefined;
                                                membersElemLate.push(
                                                    ts.factory.createPropertySignature(
                                                        undefined,
                                                        p.getName() === "__proto__"
                                                            ? ts.factory.createIdentifier("__proto__")
                                                            : ts.factory.createIdentifier(p.getName()),
                                                        undefined,
                                                        (pTypeNode as ts.TypeNode) ||
                                                            ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
                                                    ),
                                                );
                                            }
                                            rebuiltRetElemNodeLate = ts.factory.createTypeLiteralNode(membersElemLate);
                                        }
                                    } catch {
                                        /* ignore */
                                    }
                                    const retElemNodeLate =
                                        rebuiltRetElemNodeLate ||
                                        this.typeChecker.typeToTypeNode(
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
}
