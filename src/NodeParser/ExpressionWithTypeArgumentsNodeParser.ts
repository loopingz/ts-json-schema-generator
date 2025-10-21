import ts from "typescript";
import type { NodeParser } from "../NodeParser.js";
import { Context } from "../NodeParser.js";
import type { SubNodeParser } from "../SubNodeParser.js";
import type { BaseType } from "../Type/BaseType.js";

export class ExpressionWithTypeArgumentsNodeParser implements SubNodeParser {
    public constructor(
        protected typeChecker: ts.TypeChecker,
        protected childNodeParser: NodeParser,
    ) {}

    public supportsNode(node: ts.ExpressionWithTypeArguments): boolean {
        return node.kind === ts.SyntaxKind.ExpressionWithTypeArguments;
    }
    public createType(node: ts.ExpressionWithTypeArguments, context: Context): BaseType {
        const typeSymbol = this.typeChecker.getSymbolAtLocation(node.expression)!;
        console.log(typeSymbol.name, typeSymbol.flags);
        if (typeSymbol.flags & ts.SymbolFlags.Alias) {
            const aliasedSymbol = this.typeChecker.getAliasedSymbol(typeSymbol);
            console.log("  aliased to", aliasedSymbol.name, aliasedSymbol.flags);
            return this.childNodeParser.createType(
                aliasedSymbol.declarations![0],
                this.createSubContext(node, context),
            );
        } else if (typeSymbol.flags & ts.SymbolFlags.TypeParameter) {
            console.log("  is type parameter", typeSymbol.name);
            return context.getArgument(typeSymbol.name);
        } else {
            console.log("  is declaration", typeSymbol.declarations![0].kind);
            return this.childNodeParser.createType(typeSymbol.declarations![0], this.createSubContext(node, context));
        }
    }

    protected createSubContext(node: ts.ExpressionWithTypeArguments, parentContext: Context): Context {
        const subContext = new Context(node);
        if (node.typeArguments?.length) {
            node.typeArguments.forEach((typeArg) => {
                const type = this.childNodeParser.createType(typeArg, parentContext);
                subContext.pushArgument(type);
                // Try to map raw ts.Type for conditional evaluation
                try {
                    const raw = this.typeChecker.getTypeFromTypeNode(typeArg);
                    if (raw) {
                        subContext.pushOriginalTypeOrdered(raw);
                        // If the raw is just a type parameter, attempt to upgrade it using parentContext original type.
                        try {
                            if (
                                (raw.flags & ts.TypeFlags.TypeParameter) !== 0 &&
                                ts.isTypeReferenceNode(typeArg) &&
                                ts.isIdentifier(typeArg.typeName)
                            ) {
                                const paramName = typeArg.typeName.text;
                                const parentOriginal = parentContext.getOriginalType(paramName);
                                if (parentOriginal) {
                                    const list: any = (subContext as any).originalTypesInOrder;
                                    if (Array.isArray(list) && list.length > 0) {
                                        list[list.length - 1] = parentOriginal;
                                    }
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                    // Special handling: Indexed access like T[K] should map to raw property type of original T
                    if (ts.isIndexedAccessTypeNode(typeArg)) {
                        const obj = typeArg.objectType;
                        if (ts.isTypeReferenceNode(obj) && ts.isIdentifier(obj.typeName)) {
                            const paramName = obj.typeName.text;
                            const originalObj = parentContext.getOriginalType(paramName);
                            if (originalObj) {
                                // Derive key name
                                let keyName: string | undefined;
                                const idx = typeArg.indexType;
                                if (ts.isTypeReferenceNode(idx) && ts.isIdentifier(idx.typeName)) {
                                    const idxParamName = idx.typeName.text;
                                    const arg = parentContext.getArgument(idxParamName);
                                    // LiteralType base type case
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
                        }
                    }
                } catch {
                    /* ignore */
                }
            });
        }
        return subContext;
    }
}
