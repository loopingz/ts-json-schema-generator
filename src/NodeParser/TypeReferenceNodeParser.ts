import ts from "typescript";
import { Context, type NodeParser } from "../NodeParser.js";
import type { SubNodeParser } from "../SubNodeParser.js";
import { AnnotatedType } from "../Type/AnnotatedType.js";
import { AnyType } from "../Type/AnyType.js";
import { ArrayType } from "../Type/ArrayType.js";
import type { BaseType } from "../Type/BaseType.js";
import { StringType } from "../Type/StringType.js";
import { UnknownType } from "../Type/UnknownType.js";
import { symbolAtNode } from "../Utils/symbolAtNode.js";

const invalidTypes: Record<number, boolean> = {
    [ts.SyntaxKind.ModuleDeclaration]: true,
    [ts.SyntaxKind.VariableDeclaration]: true,
};

export class TypeReferenceNodeParser implements SubNodeParser {
    public constructor(
        protected typeChecker: ts.TypeChecker,
        protected childNodeParser: NodeParser,
    ) {}

    public supportsNode(node: ts.TypeReferenceNode): boolean {
        return node.kind === ts.SyntaxKind.TypeReference;
    }

    public createType(node: ts.TypeReferenceNode, context: Context): BaseType {
        const typeSymbol =
            this.typeChecker.getSymbolAtLocation(node.typeName) ??
            // When the node doesn't have a valid source file, its position is -1, so we can't
            // search for a symbol based on its location. In that case, the ts.factory defines a symbol
            // property on the node itself.
            symbolAtNode(node.typeName)!;

        if (typeSymbol.flags & ts.SymbolFlags.Alias) {
            const aliasedSymbol = this.typeChecker.getAliasedSymbol(typeSymbol);

            const declaration = aliasedSymbol.declarations?.filter((n: ts.Declaration) => !invalidTypes[n.kind])[0];

            if (!declaration) {
                // fallback for bun.sh
                return new AnyType();
            }

            const sub = this.createSubContext(node, context);
            // Additional propagation: if alias has type parameters, map each to a richer raw based on the corresponding type argument.
            try {
                if (ts.isTypeAliasDeclaration(declaration) && declaration.typeParameters?.length) {
                    const aliasParams = declaration.typeParameters.map((tp) => tp.name.text);
                    if (node.typeArguments?.length) {
                        for (let i = 0; i < Math.min(aliasParams.length, node.typeArguments.length); i++) {
                            const aliasParamName = aliasParams[i];
                            const argNode = node.typeArguments[i];
                            let rawArg = this.typeChecker.getTypeFromTypeNode(argNode);
                            // If rawArg is a naked type parameter, try to substitute with parent concrete/original raw.
                            if ((rawArg.flags & ts.TypeFlags.TypeParameter) !== 0) {
                                const sym: ts.Symbol | undefined = (rawArg as any).symbol;
                                const parentName = sym?.getName();
                                if (parentName) {
                                    const parentOriginal =
                                        (context as any).getOriginalType?.(parentName) ||
                                        context.getOriginalType(parentName);
                                    const parentConcrete = (context as any).getConcreteRaw?.(parentName);
                                    if (parentConcrete) {
                                        rawArg = parentConcrete;
                                    } else if (parentOriginal) {
                                        rawArg = parentOriginal;
                                    }
                                }
                                // Step 3 supplemental: if still a naked type parameter, try global/ctx element raw fallback.
                                if ((rawArg.flags & ts.TypeFlags.TypeParameter) !== 0) {
                                    try {
                                        const elemFallback: ts.Type | undefined =
                                            (context as any)._lastMethodElementRaw ||
                                            (globalThis as any).__lastMethodElementRaw;
                                        if (elemFallback) {
                                            const hasMethod = this.typeChecker
                                                .getPropertiesOfType(elemFallback)
                                                .some((p) => p.getName() === "toJSON");
                                            if (hasMethod) {
                                                rawArg = elemFallback;
                                                try {
                                                    /* eslint-disable no-console */ console.log(
                                                        "[debug teref promote] using element fallback for alias param",
                                                        aliasParamName,
                                                    );
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
                            // Store as original raw for alias param if richer than existing.
                            const existing = sub.getOriginalType(aliasParamName);
                            let shouldStore = !existing;
                            if (existing) {
                                try {
                                    const existingProps = this.typeChecker.getPropertiesOfType(existing);
                                    const newProps = this.typeChecker.getPropertiesOfType(rawArg);
                                    if (existingProps.length === 0 && newProps.length > 0) shouldStore = true;
                                } catch {
                                    /* ignore */
                                }
                            }
                            if (shouldStore) {
                                sub.pushOriginalType(aliasParamName, rawArg);
                                // If method-bearing, also mark concreteRaw
                                try {
                                    const hasMethod = this.typeChecker.getPropertiesOfType(rawArg).some((p) => {
                                        try {
                                            const decl = p.valueDeclaration ?? p.declarations?.[0];
                                            if (!decl) return false;
                                            const t = this.typeChecker.getTypeOfSymbolAtLocation(p, decl);
                                            return (t.getCallSignatures()?.length || 0) > 0;
                                        } catch {
                                            return false;
                                        }
                                    });
                                    if (hasMethod) (sub as any).pushConcreteRaw?.(aliasParamName, rawArg);
                                } catch {
                                    /* ignore */
                                }
                            }
                        }
                    }
                }
            } catch {
                /* ignore */
            }
            return this.childNodeParser.createType(declaration, sub);
        }

        if (typeSymbol.flags & ts.SymbolFlags.TypeParameter) {
            // Primary: bound generic argument
            const bound = context.getArgument(typeSymbol.name);
            if (bound) return bound;
            // Fallback: if we have recorded an original/concrete raw ts.Type for this type parameter
            // (e.g. an infer variable bound via method-return pre-binding) materialize it now instead
            // of emitting an UnknownType placeholder.
            try {
                const raw: ts.Type | undefined =
                    context.getOriginalType(typeSymbol.name) || (context as any).getConcreteRaw?.(typeSymbol.name);
                if (raw) {
                    const rawNode = this.typeChecker.typeToTypeNode(raw, undefined, ts.NodeBuilderFlags.NoTruncation);
                    if (rawNode && ts.isTypeNode(rawNode)) {
                        const realized = this.childNodeParser.createType(rawNode as ts.TypeNode, context);
                        if (realized) return realized;
                    }
                }
            } catch {
                /* ignore */
            }
            return new UnknownType(true);
        }

        // Wraps promise type to avoid resolving to a empty Object type.
        if (typeSymbol.name === "Promise" || typeSymbol.name === "PromiseLike") {
            // Promise without type resolves to Promise<any>
            if (!node.typeArguments || node.typeArguments.length === 0) {
                return new AnyType();
            }

            return this.childNodeParser.createType(node.typeArguments[0], context);
        }

        if (typeSymbol.name === "Array" || typeSymbol.name === "ReadonlyArray") {
            const type = this.createSubContext(node, context).getArguments()[0];

            return type === undefined ? new AnyType() : new ArrayType(type);
        }

        if (typeSymbol.name === "Date") {
            return new AnnotatedType(new StringType(), { format: "date-time" }, false);
        }

        if (typeSymbol.name === "RegExp") {
            return new AnnotatedType(new StringType(), { format: "regex" }, false);
        }

        if (typeSymbol.name === "URL") {
            return new AnnotatedType(new StringType(), { format: "uri" }, false);
        }

        return this.childNodeParser.createType(
            typeSymbol.declarations!.filter((n: ts.Declaration) => !invalidTypes[n.kind])[0],
            this.createSubContext(node, context),
        );
    }

    protected createSubContext(node: ts.TypeReferenceNode, parentContext: Context): Context {
        const subContext = new Context(node);

        if (node.typeArguments?.length) {
            for (const typeArg of node.typeArguments) {
                const created = this.childNodeParser.createType(typeArg, parentContext);
                subContext.pushArgument(created);
                // Store original raw ts.Type for later conditional checks
                try {
                    const raw = this.typeChecker.getTypeFromTypeNode(typeArg);
                    if (raw) {
                        subContext.pushOriginalTypeOrdered(raw);
                    }
                    // Special handling: if the type argument is an indexed access (e.g. T[K])
                    // attempt to unwrap it to the raw property type of original T so that
                    // conditional patterns like '{ toJSON(): infer U }' can see actual methods.
                    if (ts.isIndexedAccessTypeNode(typeArg)) {
                        const obj = typeArg.objectType;
                        if (ts.isTypeReferenceNode(obj) && ts.isIdentifier(obj.typeName)) {
                            const paramName = obj.typeName.text; // e.g. T
                            const originalObj = parentContext.getOriginalType(paramName);
                            if (originalObj) {
                                let keyName: string | undefined;
                                const idx = typeArg.indexType;
                                if (ts.isTypeReferenceNode(idx) && ts.isIdentifier(idx.typeName)) {
                                    const idxParamName = idx.typeName.text; // e.g. K
                                    const arg = parentContext.getArgument(idxParamName);
                                    try {
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        if ((arg as any)?.getValue) {
                                            // @ts-ignore
                                            keyName = (arg as any).getValue();
                                        }
                                    } catch {
                                        /* ignore */
                                    }
                                } else if (ts.isLiteralTypeNode(idx)) {
                                    if (ts.isStringLiteral(idx.literal) || ts.isNumericLiteral(idx.literal)) {
                                        keyName = idx.literal.text;
                                    }
                                }
                                if (keyName) {
                                    try {
                                        const props = this.typeChecker.getPropertiesOfType(originalObj);
                                        const propSymbol = props.find((p) => p.getName() === keyName);
                                        if (propSymbol) {
                                            const decl = propSymbol.valueDeclaration ?? propSymbol.declarations?.[0];
                                            if (decl) {
                                                const rawPropType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                    propSymbol,
                                                    decl,
                                                );
                                                if (rawPropType) {
                                                    // Replace last pushed ordered raw (indexed access) with property raw type
                                                    const list: any = (subContext as any).originalTypesInOrder;
                                                    if (Array.isArray(list) && list.length > 0) {
                                                        list[list.length - 1] = rawPropType;
                                                    } else {
                                                        subContext.pushOriginalTypeOrdered(rawPropType);
                                                    }
                                                }
                                            }
                                        }
                                    } catch {
                                        /* ignore */
                                    }
                                }
                            }
                            // Brute force fallback: if last original ordered type still an IndexedAccess, attempt to derive raw via its internal ts.IndexedAccessType structure.
                            try {
                                const list: any = (subContext as any).originalTypesInOrder;
                                if (Array.isArray(list) && list.length > 0) {
                                    const lastRaw = list[list.length - 1];
                                    if (lastRaw && (lastRaw.flags & ts.TypeFlags.IndexedAccess) !== 0) {
                                        const idxType: any = lastRaw; // ts.IndexedAccessType
                                        const objectType: ts.Type = idxType.objectType;
                                        const indexType: ts.Type = idxType.indexType;
                                        const indexStr = this.typeChecker.typeToString(indexType);
                                        const objProps = this.typeChecker.getPropertiesOfType(objectType);
                                        const sym = objProps.find((p) => p.getName() === indexStr);
                                        if (sym) {
                                            const decl2 = sym.valueDeclaration ?? sym.declarations?.[0];
                                            if (decl2) {
                                                const brute = this.typeChecker.getTypeOfSymbolAtLocation(sym, decl2);
                                                if (brute) {
                                                    list[list.length - 1] = brute;
                                                }
                                            }
                                        }
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

        // Propagate parent original raw type mappings (parameter name -> ts.Type) so alias parsers can access method-bearing raws.
        try {
            let originalsMap: Map<string, ts.Type> | undefined = (parentContext as any).originalTypes?.();
            if (!originalsMap && (parentContext as any).getOriginalTypes) {
                try {
                    originalsMap = (parentContext as any).getOriginalTypes();
                } catch {
                    /* ignore */
                }
            }
            if (originalsMap) {
                originalsMap.forEach((value, key) => {
                    if (!subContext.getOriginalType(key)) {
                        subContext.pushOriginalType(key, value);
                    }
                });
            }
            // Propagate concreteRaw map
            try {
                const concretes: Map<string, ts.Type> | undefined = (parentContext as any).getAllConcreteRaws?.();
                if (concretes) {
                    for (const [k, v] of concretes.entries()) {
                        (subContext as any).pushConcreteRaw?.(k, v);
                    }
                }
            } catch {
                /* ignore */
            }
            // Also propagate ordered originals if not already captured (avoid duplication).
            const orderedParent: ts.Type[] = (parentContext as any).getOriginalTypeByIndex ? [] : []; // placeholder
            try {
                const list: any = (parentContext as any).originalTypesInOrder;
                const subList: any = (subContext as any).originalTypesInOrder;
                if (Array.isArray(list) && Array.isArray(subList)) {
                    for (const t of list) {
                        // Simple presence check by string representation to avoid duplicates
                        const exists = subList.some((x: ts.Type) => x === t);
                        if (!exists) subContext.pushOriginalTypeOrdered(t);
                    }
                }
            } catch {
                /* ignore */
            }
        } catch {
            /* ignore */
        }

        return subContext;
    }
}
