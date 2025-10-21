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
            for (const typeParam of node.typeParameters) {
                const nameSymbol = this.typeChecker.getSymbolAtLocation(typeParam.name)!;
                context.pushParameter(nameSymbol.name);

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
                        underlyingNode = apparentNode;
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
