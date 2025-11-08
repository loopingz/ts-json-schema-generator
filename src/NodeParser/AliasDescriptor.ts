import ts from "typescript";

/** Classification of a single conditional segment inside a chained conditional type alias. */
export type AliasConditionalPattern =
    | "array-infer" // T extends (infer E)[] ? ... : ...
    | "method-return-infer" // T extends { method(): infer U } ? ... : ...
    | "other"; // any other conditional we haven't specialised yet (kept for future extension)

export interface AliasConditionalSegment {
    conditional: ts.ConditionalTypeNode; // the raw node
    pattern: AliasConditionalPattern; // structural classification
    inferIdentifiers: string[]; // any infer type parameter names found in the extendsType (or method return)
    methodName?: string; // when pattern === method-return-infer
    index: number; // order in the chain (0 = outermost)
}

export interface AliasDescriptor {
    alias: ts.TypeAliasDeclaration;
    chain: AliasConditionalSegment[]; // ordered outer -> inner
    terminalType: ts.TypeNode; // the final non-conditional falseType tail (or the alias.type if no conditionals)
    root: ts.TypeNode; // original alias.type
}

// Internal cache so we only build once per alias declaration.
const descriptorCache = new WeakMap<ts.TypeAliasDeclaration, AliasDescriptor>();

function collectInferIdentifiers(node: ts.Node, acc: string[]): void {
    node.forEachChild((child) => {
        if (ts.isInferTypeNode(child)) {
            acc.push(child.typeParameter.name.text);
        }
        collectInferIdentifiers(child, acc);
    });
}

function classifyPattern(conditional: ts.ConditionalTypeNode): {
    pattern: AliasConditionalPattern;
    inferIdentifiers: string[];
    methodName?: string;
} {
    const inferIdentifiers: string[] = [];
    const extendsNode = conditional.extendsType;

    let pattern: AliasConditionalPattern = "other";
    let methodName: string | undefined;

    // Pattern 1: Array infer   T extends (infer E)[] or T extends Array<infer E>
    if (ts.isArrayTypeNode(extendsNode) && ts.isInferTypeNode(extendsNode.elementType)) {
        pattern = "array-infer";
        inferIdentifiers.push(extendsNode.elementType.typeParameter.name.text);
    } else if (
        ts.isTypeReferenceNode(extendsNode) &&
        extendsNode.typeArguments &&
        extendsNode.typeArguments.length === 1 &&
        ts.isInferTypeNode(extendsNode.typeArguments[0])
    ) {
        // Handles Array<infer E>
        pattern = "array-infer";
        inferIdentifiers.push(extendsNode.typeArguments[0].typeParameter.name.text);
    } else if (ts.isTypeLiteralNode(extendsNode)) {
        // Pattern 2: Method return infer  T extends { method(): infer U }
        const methodMembers = extendsNode.members.filter((m): m is ts.MethodSignature => ts.isMethodSignature(m));
        if (methodMembers.length === 1) {
            const method = methodMembers[0];
            if (method.type && ts.isInferTypeNode(method.type)) {
                pattern = "method-return-infer";
                inferIdentifiers.push(method.type.typeParameter.name.text);
                if (method.name && ts.isIdentifier(method.name)) {
                    methodName = method.name.text;
                }
            }
        }
        if (pattern === "other") {
            collectInferIdentifiers(extendsNode, inferIdentifiers);
        }
    } else {
        collectInferIdentifiers(extendsNode, inferIdentifiers);
    }

    return { pattern, inferIdentifiers, methodName };
}

export function buildAliasDescriptor(alias: ts.TypeAliasDeclaration): AliasDescriptor {
    const cached = descriptorCache.get(alias);
    if (cached) return cached;

    const chain: AliasConditionalSegment[] = [];
    let cursor: ts.TypeNode = alias.type;
    let index = 0;
    while (ts.isConditionalTypeNode(cursor)) {
        const classification = classifyPattern(cursor);
        chain.push({
            conditional: cursor,
            pattern: classification.pattern,
            inferIdentifiers: classification.inferIdentifiers,
            methodName: classification.methodName,
            index,
        });
        // Traverse into false branch to flatten left-associative chain: A ? B : (C ? D : E)
        if (ts.isConditionalTypeNode(cursor.falseType)) {
            cursor = cursor.falseType;
            index += 1;
            continue;
        }
        break; // end of chain
    }
    const terminalType: ts.TypeNode = ts.isConditionalTypeNode(cursor)
        ? cursor.falseType // last conditional's false branch
        : cursor; // no conditionals at all or final non-conditional tail

    const descriptor: AliasDescriptor = {
        alias,
        chain,
        terminalType,
        root: alias.type,
    };
    descriptorCache.set(alias, descriptor);
    return descriptor;
}

export function getAliasDescriptor(alias: ts.TypeAliasDeclaration): AliasDescriptor | undefined {
    return descriptorCache.get(alias);
}
