import ts from "typescript";
import { Context, NodeParser } from "../NodeParser.js";
import { SubNodeParser } from "../SubNodeParser.js";
import { BaseType } from "../Type/BaseType.js";

export class ThisTypeNodeParser implements SubNodeParser {
    public constructor(
        protected typeChecker: ts.TypeChecker,
        protected childNodeParser: NodeParser,
    ) {}

    public supportsNode(node: ts.ThisTypeNode): boolean {
        return node.kind === ts.SyntaxKind.ThisType;
    }

    public createType(node: ts.ThisTypeNode, context: Context): BaseType | undefined {
        return context.getThisType();
    }
}
