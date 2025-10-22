import ts from "typescript";
import type { Context } from "../NodeParser.js";
import type { AliasDescriptor } from "./AliasDescriptor.js";

/** Result of attempting to bind an infer variable to a method return type. */
export interface MethodReturnBindingResult {
    inferName: string;
    methodName: string;
    returnType: ts.Type;
    rebuiltLiteral?: ts.TypeNode; // reconstructed literal for stable property enumeration
}

/**
 * Given an alias descriptor, attempt to pre-bind any infer variable coming from a
 * method-return-infer segment ( T extends { method(): infer U } ? ... ) by resolving
 * the actual method return type from the bound raw type of the check side.
 *
 * This is a preparatory phase; by inserting the resolved return type into the context
 * under the infer variable name, subsequent evaluation of the conditional true branch
 * will see concrete structure (e.g. ensuring properties like 'upper' are preserved).
 */
export function attemptBindMethodReturn(
    descriptor: AliasDescriptor,
    typeChecker: ts.TypeChecker,
    context: Context,
): MethodReturnBindingResult[] {
    const results: MethodReturnBindingResult[] = [];
    for (const seg of descriptor.chain) {
        if (seg.pattern !== "method-return-infer" || !seg.methodName) continue;
        // Expect exactly one infer identifier for this pattern
        const inferName = seg.inferIdentifiers[0];
        if (!inferName) continue;
        const conditional = seg.conditional;
        // Only support simple identifier (type parameter) on check side for now.
        let checkParamName: string | undefined;
        const ct = conditional.checkType;
        if (ts.isTypeReferenceNode(ct) && ts.isIdentifier(ct.typeName)) {
            checkParamName = ct.typeName.text;
        } else if (ts.isTypeQueryNode(ct) && ts.isIdentifier(ct.exprName)) {
            checkParamName = ct.exprName.text; // unlikely, but keep generic
        } else if (ts.isTypeOperatorNode(ct) && ts.isTypeReferenceNode(ct.type) && ts.isIdentifier(ct.type.typeName)) {
            checkParamName = ct.type.typeName.text;
        } else if (ts.isTypeReferenceNode(ct) === false && (ct as any).kind === ts.SyntaxKind.Identifier) {
            // raw Identifier masquerading as TypeNode (rare in our AST path)
            const id = ct as unknown as ts.Identifier;
            checkParamName = id.text;
        }
        if (!checkParamName) continue;
        const raw = context.getOriginalType(checkParamName) || (context as any).getConcreteRaw?.(checkParamName);
        if (!raw) continue;
        // Find method symbol
        let methodSym: ts.Symbol | undefined;
        try {
            methodSym = typeChecker.getPropertiesOfType(raw).find((s) => s.getName() === seg.methodName);
        } catch {
            /* ignore */
        }
        if (!methodSym) continue;
        let sig: ts.Signature | undefined;
        try {
            const decl = methodSym.valueDeclaration ?? methodSym.declarations?.[0];
            if (!decl) continue;
            const methodType = typeChecker.getTypeOfSymbolAtLocation(methodSym, decl);
            sig = methodType.getCallSignatures()?.[0];
        } catch {
            /* ignore */
        }
        if (!sig) continue;
        let returnType: ts.Type;
        try {
            returnType = sig.getReturnType();
        } catch {
            continue;
        }
        // Rebuild literal (stable order) if object-like
        let rebuiltLiteral: ts.TypeNode | undefined;
        try {
            const props = typeChecker.getPropertiesOfType(returnType);
            if (props.length) {
                const members: ts.TypeElement[] = [];
                for (const p of props) {
                    const d = p.valueDeclaration ?? p.declarations?.[0];
                    let pType: ts.Type | undefined;
                    try {
                        pType = typeChecker.getTypeOfSymbolAtLocation(p, d ?? (descriptor.alias as any));
                    } catch {
                        /* ignore */
                    }
                    const pNode = pType
                        ? typeChecker.typeToTypeNode(pType, undefined, ts.NodeBuilderFlags.NoTruncation)
                        : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
                    members.push(
                        ts.factory.createPropertySignature(
                            undefined,
                            ts.factory.createIdentifier(p.getName()),
                            undefined,
                            pNode as ts.TypeNode,
                        ),
                    );
                }
                rebuiltLiteral = ts.factory.createTypeLiteralNode(members);
            }
        } catch {
            /* ignore */
        }
        // Inject into context for later resolution. We don't add as parameter (infer variable),
        // just bind it as an available original / concrete type so when referenced it materializes.
        try {
            if (!context.getOriginalType(inferName)) {
                context.pushOriginalType(inferName, returnType);
            }
            (context as any).pushConcreteRaw?.(inferName, returnType);
        } catch {
            /* ignore */
        }
        results.push({ inferName, methodName: seg.methodName, returnType, rebuiltLiteral });
    }
    return results;
}
