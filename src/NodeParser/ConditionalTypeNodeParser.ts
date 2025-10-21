import ts from "typescript";
import type { NodeParser } from "../NodeParser.js";
import { Context } from "../NodeParser.js";
import type { SubNodeParser } from "../SubNodeParser.js";
import type { BaseType } from "../Type/BaseType.js";
import { isAssignableTo } from "../Utils/isAssignableTo.js";
import { narrowType } from "../Utils/narrowType.js";
import { UnionType } from "../Type/UnionType.js";
import { NeverType } from "../Type/NeverType.js";

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
        console.log("condition type called");
        const inferMap = new Map();
        // Prefer original raw type bound to parameter (contains methods) over synthesized T reference
        let boundRawType = checkTypeParameterName ? context.getOriginalType(checkTypeParameterName) : undefined;
        // Special handling: Indexed access T[K] -> retrieve property raw type from original T using key literal
        if (!boundRawType && ts.isIndexedAccessTypeNode(node.checkType)) {
            const obj = node.checkType.objectType;
            if (ts.isTypeReferenceNode(obj) && ts.isIdentifier(obj.typeName)) {
                const objParam = obj.typeName.text;
                const rawObj = context.getOriginalType(objParam);
                if (rawObj) {
                    // Derive key names from indexType (may be union of literals)
                    const indexNode = node.checkType.indexType;
                    const keyNames: string[] = [];
                    if (ts.isLiteralTypeNode(indexNode)) {
                        if (ts.isStringLiteral(indexNode.literal) || ts.isNumericLiteral(indexNode.literal)) {
                            keyNames.push(indexNode.literal.text);
                        }
                    } else if (ts.isTypeReferenceNode(indexNode) && ts.isIdentifier(indexNode.typeName)) {
                        // Index is a mapped type parameter like K; try to get its argument (a LiteralType) from context
                        const idxParam = indexNode.typeName.text;
                        const idxArg = context.getArgument(idxParam);
                        // Attempt to read value from LiteralType
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            if ((idxArg as any)?.getValue) {
                                // @ts-ignore
                                keyNames.push((idxArg as any).getValue().toString());
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                    if (keyNames.length === 0) {
                        // fallback use type checker stringification
                        keyNames.push(this.typeChecker.typeToString(this.typeChecker.getTypeFromTypeNode(indexNode)));
                    }
                    try {
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
                    } catch {
                        /* ignore */
                    }
                }
            }
        }
        // If bound raw type is an indexed access (e.g., T[K]) try to unwrap to actual property raw type
        try {
            if (boundRawType && (boundRawType.flags & ts.TypeFlags.IndexedAccess) !== 0) {
                const idx: any = boundRawType; // ts.IndexedAccessType
                const objectTypeParamName = checkTypeParameterName; // underlying object param is same generic name
                const objectRaw = objectTypeParamName ? context.getOriginalType(objectTypeParamName) : undefined;
                if (objectRaw) {
                    // Try to derive key textual representation
                    const keyType: ts.Type = idx.indexType;
                    let keyNames: string[] = [];
                    if ((keyType.flags & ts.TypeFlags.Union) !== 0) {
                        keyNames = (keyType as ts.UnionType).types.map((t) => this.typeChecker.typeToString(t));
                    } else {
                        keyNames = [this.typeChecker.typeToString(keyType)];
                    }
                    // Fallback: if keyNames look like generic parameter (e.g. 'K'), attempt to resolve
                    // actual literal value from current context arguments
                    if (
                        keyNames.length === 1 &&
                        keyNames[0].length === 1 &&
                        context.getParameters().includes(keyNames[0])
                    ) {
                        const param = keyNames[0];
                        const arg = context.getArgument(param);
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            if ((arg as any)?.getValue) {
                                // @ts-ignore
                                const literalVal = (arg as any).getValue();
                                if (typeof literalVal === "string" || typeof literalVal === "number") {
                                    keyNames = [literalVal.toString()];
                                }
                            }
                        } catch {
                            /* ignore */
                        }
                    }
                    const props = this.typeChecker.getPropertiesOfType(objectRaw);
                    for (const keyName of keyNames) {
                        const prop = props.find((p) => p.getName() === keyName);
                        if (prop) {
                            const decl = prop.valueDeclaration ?? prop.declarations?.[0];
                            if (decl) {
                                const rawPropType = this.typeChecker.getTypeOfSymbolAtLocation(prop, decl);
                                if (rawPropType) {
                                    boundRawType = rawPropType;
                                    try {
                                        console.log(
                                            "  unwrapped indexed access to raw property type",
                                            keyName,
                                            this.typeChecker.typeToString(boundRawType),
                                        );
                                    } catch {
                                        /* ignore */
                                    }
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
        if (rawCheckType && rawExtendsType) {
            // Resolve
            const describeType = (type: ts.Type): any => {
                const symbol = type.getSymbol();
                const isUnion = (type.flags & ts.TypeFlags.Union) !== 0;
                const isIntersection = (type.flags & ts.TypeFlags.Intersection) !== 0;
                const members = isUnion || isIntersection ? (type as ts.UnionOrIntersectionType).types : [];
                return {
                    text: this.typeChecker.typeToString(type),
                    flags: type.flags,
                    kind: isUnion ? "union" : isIntersection ? "intersection" : "single",
                    constituents: members.map((t) => this.typeChecker.typeToString(t)),
                    properties: symbol
                        ? this.typeChecker.getPropertiesOfType(type).map((s) => {
                              const decl = s.valueDeclaration ?? s.declarations?.[0];
                              let propType: ts.Type | undefined;
                              try {
                                  if (decl) {
                                      propType = this.typeChecker.getTypeOfSymbolAtLocation(s, decl);
                                  }
                              } catch {
                                  /* ignore */
                              }
                              return {
                                  name: s.getName(),
                                  optional: !!(s.getFlags() & ts.SymbolFlags.Optional),
                                  type: propType ? this.typeChecker.typeToString(propType) : undefined,
                              };
                          })
                        : undefined,
                    constraint: (type as any).getConstraint
                        ? (() => {
                              try {
                                  const c = (type as any).getConstraint();
                                  return c ? this.typeChecker.typeToString(c) : undefined;
                              } catch {
                                  return undefined;
                              }
                          })()
                        : undefined,
                    default: (type as any).getDefault
                        ? (() => {
                              try {
                                  const d = (type as any).getDefault();
                                  return d ? this.typeChecker.typeToString(d) : undefined;
                              } catch {
                                  return undefined;
                              }
                          })()
                        : undefined,
                    aliasSymbol: (type as any).aliasSymbol ? (type as any).aliasSymbol.getName() : undefined,
                };
            };

            try {
                console.log("  readable rawCheckType", JSON.stringify(describeType(rawCheckType), null, 2));
            } catch {
                /* ignore serialization issues */
            }
            console.log(
                "  raw",
                this.typeChecker.typeToString(rawCheckType),
                "extends",
                this.typeChecker.typeToString(rawExtendsType),
                "=>",
                this.typeChecker.isTypeAssignableTo(rawCheckType, rawExtendsType),
            );

            // Special case: pattern '{ toJSON(): infer U }'
            if (checkTypeParameterName) {
                if (
                    ts.isTypeLiteralNode(node.extendsType) &&
                    node.extendsType.members.some(
                        (m) => ts.isMethodSignature(m) && m.name && ts.isIdentifier(m.name) && m.name.text === "toJSON",
                    )
                ) {
                    // Detect real method presence on bound raw type
                    const targetRaw = boundRawType ?? rawCheckType;
                    // Heuristic: if targetRaw prints as indexed access (e.g. 'T["object"]' or 'T[K]') attempt to unwrap
                    // to concrete property raw type using parent generic raw 'T' and key argument value.
                    try {
                        const printed = this.typeChecker.typeToString(targetRaw);
                        if (checkTypeParameterName && /\bT\[[^\]]+\]/.test(printed)) {
                            const objectRaw = context.getOriginalType(checkTypeParameterName);
                            if (objectRaw) {
                                // derive key name from context argument K if present
                                let keyName: string | undefined;
                                // attempt to find parameter 'K'
                                if (context.getParameters().includes("K")) {
                                    const kArg = context.getArgument("K");
                                    try {
                                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                        if ((kArg as any)?.getValue) {
                                            // @ts-ignore
                                            keyName = (kArg as any).getValue().toString();
                                        }
                                    } catch {
                                        /* ignore */
                                    }
                                }
                                // fallback: extract inside brackets if string literal
                                if (!keyName) {
                                    const m = printed.match(/T\[(?:"([^"]+)"|'([^']+)'|(\w+))\]/);
                                    if (m) {
                                        keyName = m[1] || m[2] || m[3];
                                    }
                                }
                                if (keyName) {
                                    try {
                                        const props = this.typeChecker.getPropertiesOfType(objectRaw);
                                        const propSym = props.find((p) => p.getName() === keyName);
                                        if (propSym) {
                                            const decl = propSym.valueDeclaration ?? propSym.declarations?.[0];
                                            if (decl) {
                                                const propRawType = this.typeChecker.getTypeOfSymbolAtLocation(
                                                    propSym,
                                                    decl,
                                                );
                                                if (propRawType) {
                                                    boundRawType = propRawType;
                                                    console.log(
                                                        "  heuristic unwrap indexed access",
                                                        printed,
                                                        "=>",
                                                        this.typeChecker.typeToString(boundRawType),
                                                    );
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
                    let hasToJSON = false;
                    try {
                        hasToJSON = this.typeChecker
                            .getPropertiesOfType(targetRaw)
                            .some((s) => s.getName() === "toJSON");
                    } catch {
                        /* ignore */
                    }
                    if (hasToJSON) {
                        // Attempt to directly resolve return type of toJSON() and use it as substitution for inferred U.
                        try {
                            const toJSONProp = this.typeChecker
                                .getPropertiesOfType(targetRaw)
                                .find((s) => s.getName() === "toJSON");
                            if (toJSONProp) {
                                const decl = toJSONProp.valueDeclaration ?? toJSONProp.declarations?.[0];
                                if (decl) {
                                    const methodType = this.typeChecker.getTypeOfSymbolAtLocation(toJSONProp, decl);
                                    const sig = methodType.getCallSignatures()?.[0];
                                    if (sig) {
                                        const retType = sig.getReturnType();
                                        // Build a synthetic type node from return type and parse it
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
                                            if (resolved) {
                                                return resolved;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch {
                            /* ignore and fallback to existing mechanism */
                        }
                        const result = this.childNodeParser.createType(
                            node.trueType,
                            this.createSubContext(
                                node,
                                context,
                                new CheckType(checkTypeParameterName, checkType),
                                inferMap,
                            ),
                        );
                        return result;
                    }
                }
            }
            // Special handling: checkType is an indexed access like T[K]
            if (!checkTypeParameterName && ts.isIndexedAccessTypeNode(node.checkType)) {
                if (
                    ts.isTypeLiteralNode(node.extendsType) &&
                    node.extendsType.members.some(
                        (m) => ts.isMethodSignature(m) && m.name && ts.isIdentifier(m.name) && m.name.text === "toJSON",
                    )
                ) {
                    // Attempt to resolve raw property type from original object generic parameter
                    let objectParamName: string | undefined;
                    const obj = node.checkType.objectType;
                    if (ts.isTypeReferenceNode(obj) && ts.isIdentifier(obj.typeName)) {
                        objectParamName = obj.typeName.text; // e.g. T
                    }
                    let keyName: string | undefined;
                    const idx = node.checkType.indexType;
                    if (ts.isTypeReferenceNode(idx) && ts.isIdentifier(idx.typeName)) {
                        const keyParamName = idx.typeName.text; // e.g. K
                        const keyArg = context.getArgument(keyParamName);
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            if ((keyArg as any)?.getValue) {
                                // @ts-ignore
                                keyName = (keyArg as any).getValue().toString();
                            }
                        } catch {
                            /* ignore */
                        }
                    } else if (ts.isLiteralTypeNode(idx)) {
                        if (ts.isStringLiteral(idx.literal) || ts.isNumericLiteral(idx.literal)) {
                            keyName = idx.literal.text;
                        }
                    }
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
                                        const hasToJSON = this.typeChecker
                                            .getPropertiesOfType(propRawType)
                                            .some((s) => s.getName() === "toJSON");
                                        if (hasToJSON) {
                                            // Directly evaluate true branch in current context (no parameter narrowing)
                                            return this.childNodeParser.createType(
                                                node.trueType,
                                                this.createSubContext(node, context, undefined, inferMap),
                                            );
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
        }

        // If check-type is not a type parameter then condition is very simple, no type narrowing needed
        if (checkTypeParameterName == null) {
            const result = isAssignableTo(extendsType, checkType, inferMap);
            return this.childNodeParser.createType(
                result ? node.trueType : node.falseType,
                this.createSubContext(node, context, undefined, result ? inferMap : new Map()),
            );
        }

        // Narrow down check type for both condition branches
        const trueCheckType = narrowType(checkType, (type) => isAssignableTo(extendsType, type, inferMap));
        const falseCheckType = narrowType(checkType, (type) => !isAssignableTo(extendsType, type));

        // Follow the relevant branches and return the results from them
        const results: BaseType[] = [];
        if (!(trueCheckType instanceof NeverType)) {
            const result = this.childNodeParser.createType(
                node.trueType,
                this.createSubContext(node, context, new CheckType(checkTypeParameterName, trueCheckType), inferMap),
            );
            if (result) {
                results.push(result);
            }
        }
        if (!(falseCheckType instanceof NeverType)) {
            const result = this.childNodeParser.createType(
                node.falseType,
                this.createSubContext(node, context, new CheckType(checkTypeParameterName, falseCheckType)),
            );
            if (result) {
                results.push(result);
            }
        }
        return new UnionType(results).normalize();
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
            if (typeSymbol.flags & ts.SymbolFlags.TypeParameter) {
                return typeSymbol.name;
            }
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

        // Newly inferred types take precedence over check and parent types.
        inferMap.forEach((value, key) => {
            subContext.pushParameter(key);
            subContext.pushArgument(value);
        });

        if (checkType !== undefined) {
            // Set new narrowed type for check type parameter
            if (!(checkType.parameterName in inferMap)) {
                subContext.pushParameter(checkType.parameterName);
                subContext.pushArgument(checkType.type);
                // Propagate original raw argument type (methods etc.) if present on parent
                const original = parentContext.getOriginalType(checkType.parameterName);
                if (original) {
                    subContext.pushOriginalType(checkType.parameterName, original);
                }
            }
        }

        // Copy all other type parameters from parent context
        parentContext.getParameters().forEach((parentParameter) => {
            if (parentParameter !== checkType?.parameterName && !(parentParameter in inferMap)) {
                subContext.pushParameter(parentParameter);
                subContext.pushArgument(parentContext.getArgument(parentParameter));
                const original = parentContext.getOriginalType(parentParameter);
                if (original) {
                    subContext.pushOriginalType(parentParameter, original);
                }
            }
        });

        // If we narrowed a checkType that originated from a raw ts.Type, keep original for possible further checks
        if (checkType?.parameterName) {
            // Attempt to capture original raw TS type of the conditional check branch.
            try {
                const raw = this.typeChecker.getTypeFromTypeNode(node.checkType);
                if (raw) {
                    const existing = parentContext.getOriginalType(checkType.parameterName);
                    if (existing) {
                        let existingPropsLen = 0;
                        let newPropsLen = 0;
                        try {
                            existingPropsLen = this.typeChecker.getPropertiesOfType(existing).length;
                        } catch {
                            /* ignore */
                        }
                        try {
                            newPropsLen = this.typeChecker.getPropertiesOfType(raw).length;
                        } catch {
                            /* ignore */
                        }
                        const isIndexed = (raw.flags & ts.TypeFlags.IndexedAccess) !== 0;
                        const isTypeParamRaw = (raw.flags & ts.TypeFlags.TypeParameter) !== 0;
                        // Preserve existing if it is richer (has properties) and new raw loses them (no props),
                        // or if new raw is an IndexedAccess wrapper, or still just the generic TypeParameter.
                        if (existingPropsLen > 0 && (newPropsLen === 0 || isIndexed || isTypeParamRaw)) {
                            subContext.pushOriginalType(checkType.parameterName, existing);
                            try {
                                console.log(
                                    "  preserve existing original raw for",
                                    checkType.parameterName,
                                    "props:",
                                    existingPropsLen,
                                    "newProps:",
                                    newPropsLen,
                                    "isIndexed:",
                                    isIndexed,
                                    "isTypeParamRaw:",
                                    isTypeParamRaw,
                                );
                            } catch {
                                /* ignore */
                            }
                        } else {
                            subContext.pushOriginalType(checkType.parameterName, raw);
                            try {
                                console.log(
                                    "  override original raw for",
                                    checkType.parameterName,
                                    "newProps:",
                                    newPropsLen,
                                    "existingProps:",
                                    existingPropsLen,
                                );
                            } catch {
                                /* ignore */
                            }
                        }
                    } else {
                        subContext.pushOriginalType(checkType.parameterName, raw);
                        try {
                            console.log("  set original raw for", checkType.parameterName, "(no existing)");
                        } catch {
                            /* ignore */
                        }
                    }
                }
            } catch {
                /* ignore */
            }
        }

        return subContext;
    }
}
