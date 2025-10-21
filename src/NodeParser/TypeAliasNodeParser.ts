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

    public supportsNode(node: ts.TypeAliasDeclaration): boolean {
        return node.kind === ts.SyntaxKind.TypeAliasDeclaration;
    }

    public createType(node: ts.TypeAliasDeclaration, context: Context, reference?: ReferenceType): BaseType {
        if (node.typeParameters?.length) {
            for (let i = 0; i < node.typeParameters.length; i++) {
                const typeParam = node.typeParameters[i];
                const nameSymbol = this.typeChecker.getSymbolAtLocation(typeParam.name)!;
                context.pushParameter(nameSymbol.name);
                // Bind previously captured original raw type by index if available
                let raw = context.getOriginalTypeByIndex(i);
                if (raw) {
                    try {
                        console.log(
                            "  binding raw for alias param",
                            nameSymbol.name,
                            this.typeChecker.typeToString(raw),
                            raw.flags,
                        );
                    } catch {
                        /* ignore */
                    }
                } else {
                    console.log("  no raw found for alias param", nameSymbol.name, i);
                }
                if (raw) {
                    const existingOriginal = context.getOriginalType(nameSymbol.name);
                    const isIndexed = (raw.flags & ts.TypeFlags.IndexedAccess) !== 0;
                    let skipOverride = false;
                    if (existingOriginal && isIndexed) {
                        try {
                            const existingProps = this.typeChecker.getPropertiesOfType(existingOriginal);
                            if (existingProps.length > 0) {
                                skipOverride = true; // keep richer original (with methods)
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
                    }
                }

                if (typeParam.default) {
                    const type = this.childNodeParser.createType(typeParam.default, context);
                    context.setDefault(nameSymbol.name, type);
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
                    if (apparentNode && ts.isTypeNode(apparentNode)) {
                        underlyingNode = apparentNode as ts.TypeNode;
                    }
                    console.log("  apparent", safeNodePrint(underlyingNode, node.getSourceFile(), this.typeChecker));
                }
            } catch (e) {
                // Swallow; fallback to original node
                console.log("hasInfer error", e);
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
