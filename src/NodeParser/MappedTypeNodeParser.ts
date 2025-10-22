import ts from "typescript";
import { ExpectationFailedError } from "../Error/Errors.js";
import type { NodeParser } from "../NodeParser.js";
import { Context } from "../NodeParser.js";
import type { SubNodeParser } from "../SubNodeParser.js";
import { AnnotatedType } from "../Type/AnnotatedType.js";
import { ArrayType } from "../Type/ArrayType.js";
import type { BaseType } from "../Type/BaseType.js";
import { DefinitionType } from "../Type/DefinitionType.js";
import type { EnumValue } from "../Type/EnumType.js";
import { EnumType } from "../Type/EnumType.js";
import { LiteralType } from "../Type/LiteralType.js";
import { NeverType } from "../Type/NeverType.js";
import { NumberType } from "../Type/NumberType.js";
import { ObjectProperty, ObjectType } from "../Type/ObjectType.js";
import { StringType } from "../Type/StringType.js";
import { SymbolType } from "../Type/SymbolType.js";
import { UnionType } from "../Type/UnionType.js";
import { derefAnnotatedType, derefType, isDeepLiteralUnion } from "../Utils/derefType.js";
import { getKey } from "../Utils/nodeKey.js";
import { preserveAnnotation } from "../Utils/preserveAnnotation.js";
import { removeUndefined } from "../Utils/removeUndefined.js";
import { uniqueTypeArray } from "../Utils/uniqueTypeArray.js";

export class MappedTypeNodeParser implements SubNodeParser {
    public constructor(
        protected childNodeParser: NodeParser,
        protected readonly additionalProperties: boolean,
    ) {}

    public supportsNode(node: ts.MappedTypeNode): boolean {
        return node.kind === ts.SyntaxKind.MappedType;
    }

    public createType(node: ts.MappedTypeNode, context: Context): BaseType {
        const constraintType = this.childNodeParser.createType(node.typeParameter.constraint!, context);
        const keyListType = derefType(constraintType);
        const id = `indexed-type-${getKey(node, context)}`;

        if (keyListType instanceof UnionType) {
            // Key type resolves to a set of known properties
            return new ObjectType(
                id,
                [],
                this.getProperties(node, keyListType, context),
                this.getAdditionalProperties(node, keyListType, context),
            );
        }

        if (keyListType instanceof LiteralType) {
            // Key type resolves to single known property
            return new ObjectType(id, [], this.getProperties(node, new UnionType([keyListType]), context), false);
        }

        if (
            keyListType instanceof StringType ||
            keyListType instanceof NumberType ||
            keyListType instanceof SymbolType
        ) {
            if (constraintType?.getId() === "number") {
                const type = this.childNodeParser.createType(
                    node.type!,
                    this.createSubContext(node, keyListType, context),
                );
                return type instanceof NeverType ? new NeverType() : new ArrayType(type);
            }
            // Key type widens to `string`
            const type = this.childNodeParser.createType(node.type!, this.createSubContext(node, keyListType, context));
            // const resultType = type instanceof NeverType ? new NeverType() : new ObjectType(id, [], [], type);
            const resultType = new ObjectType(id, [], [], type);
            if (resultType) {
                let annotations;

                if (constraintType instanceof AnnotatedType) {
                    annotations = constraintType.getAnnotations();
                } else if (constraintType instanceof DefinitionType) {
                    const childType = constraintType.getType();
                    if (childType instanceof AnnotatedType) {
                        annotations = childType.getAnnotations();
                    }
                }
                if (annotations) {
                    return new AnnotatedType(resultType, { propertyNames: annotations }, false);
                }
            }
            return resultType;
        }

        if (keyListType instanceof EnumType) {
            return new ObjectType(id, [], this.getValues(node, keyListType, context), false);
        }

        if (keyListType instanceof NeverType) {
            return new ObjectType(id, [], [], false);
        }

        throw new ExpectationFailedError(
            `Unexpected key type "${
                constraintType ? constraintType.getId() : constraintType
            }" for this node. (expected "UnionType" or "StringType")`,
            node,
        );
    }

    protected mapKey(node: ts.MappedTypeNode, rawKey: LiteralType, context: Context): BaseType {
        if (!node.nameType) {
            return rawKey;
        }
        return derefType(this.childNodeParser.createType(node.nameType, this.createSubContext(node, rawKey, context)));
    }

    protected getProperties(node: ts.MappedTypeNode, keyListType: UnionType, context: Context): ObjectProperty[] {
        return uniqueTypeArray(keyListType.getFlattenedTypes(derefType))
            .filter((type): type is LiteralType => type instanceof LiteralType)
            .map((type) => [type, this.mapKey(node, type, context)])
            .filter((value): value is [LiteralType, LiteralType] => value[1] instanceof LiteralType)
            .reduce((result: ObjectProperty[], [key, mappedKey]: [LiteralType, LiteralType]) => {
                const subContext = this.createSubContext(node, key, context);
                const propertyType = this.childNodeParser.createType(node.type!, subContext);

                // Attempt early substitution for method-based serialization patterns:
                // 1. toJSON(): infer U (handled by finding toJSON and substituting its return type)
                // 2. fromDto(param: infer U): any  (Dto pattern) -> we keep U's shape instead of the whole object
                // Detect pattern by inspecting original raw type for this key name.
                try {
                    const keyName = key.getValue().toString();
                    const rawProp = subContext.getOriginalType(keyName);
                    if (rawProp) {
                        const tc: ts.TypeChecker | undefined = (this.childNodeParser as any).typeChecker;
                        if (tc) {
                            // Skip arrays: let conditional branch handle (infer E)[] logic.
                            const isArray = !!tc.getIndexTypeOfType(rawProp, ts.IndexKind.Number);
                            if (!isArray) {
                                const props = tc.getPropertiesOfType(rawProp);
                                // Only consider explicit toJSON; ignore common prototype methods.
                                const processMethodReturnType = (methodSym: ts.Symbol, label: string) => {
                                    const decl = methodSym.valueDeclaration ?? methodSym.declarations?.[0];
                                    if (!decl) return;
                                    const mType = tc.getTypeOfSymbolAtLocation(methodSym, decl);
                                    const sig = mType.getCallSignatures()?.[0];
                                    if (!sig) return;
                                    const ret = sig.getReturnType();
                                    const retNode = tc.typeToTypeNode(ret, undefined, ts.NodeBuilderFlags.NoTruncation);
                                    if (retNode && ts.isTypeNode(retNode)) {
                                        const replaced = this.childNodeParser.createType(retNode, subContext);
                                        if (replaced) {
                                            (propertyType as any) = replaced;
                                        }
                                    }
                                };
                                const toJSONSym = props.find((p) => p.getName && p.getName() === "toJSON");
                                if (toJSONSym) {
                                    const declSource = (rawProp as any).symbol?.declarations || [];
                                    const validDeclSource = declSource.some(
                                        (d: ts.Declaration) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d),
                                    );
                                    if (validDeclSource) processMethodReturnType(toJSONSym, "toJSON");
                                }
                            }
                        }
                    }
                } catch {
                    /* ignore */
                }

                let newType = derefAnnotatedType(propertyType);
                let hasUndefined = false;
                if (newType instanceof UnionType) {
                    const { newType: newType_, numRemoved } = removeUndefined(newType);
                    hasUndefined = numRemoved > 0;
                    newType = newType_;
                }

                const objectProperty = new ObjectProperty(
                    mappedKey.getValue().toString(),
                    preserveAnnotation(propertyType, newType),
                    !node.questionToken && !hasUndefined,
                );

                result.push(objectProperty);
                return result;
            }, []);
    }

    protected getValues(node: ts.MappedTypeNode, keyListType: EnumType, context: Context): ObjectProperty[] {
        return keyListType
            .getValues()
            .filter((value: EnumValue) => value != null)
            .map((value: EnumValue) => {
                const type = this.childNodeParser.createType(
                    node.type!,
                    this.createSubContext(node, new LiteralType(value!), context),
                );

                return new ObjectProperty(value!.toString(), type, !node.questionToken);
            });
    }

    protected getAdditionalProperties(
        node: ts.MappedTypeNode,
        keyListType: UnionType,
        context: Context,
    ): BaseType | boolean {
        if (isDeepLiteralUnion(keyListType)) {
            return this.additionalProperties;
        }

        const key = keyListType.getTypes().filter((type) => !(derefType(type) instanceof LiteralType))[0];

        if (key) {
            return (
                this.childNodeParser.createType(node.type!, this.createSubContext(node, key, context)) ??
                this.additionalProperties
            );
        }

        return this.additionalProperties;
    }

    protected createSubContext(
        node: ts.MappedTypeNode,
        key: LiteralType | StringType | NumberType,
        parentContext: Context,
    ): Context {
        const subContext = new Context(node);

        // Propagate parameters, arguments and original raw types
        for (const parentParameter of parentContext.getParameters()) {
            subContext.pushParameter(parentParameter);
            subContext.pushArgument(parentContext.getArgument(parentParameter));
            const original = parentContext.getOriginalType(parentParameter);
            if (original) {
                subContext.pushOriginalType(parentParameter, original);
            }
        }

        subContext.pushParameter(node.typeParameter.name.text);
        subContext.pushArgument(key);
        // Key is a literal; no original raw type needed

        // Attempt to propagate raw property type for Jsonify mapped distribution:
        // If parent generic parameter (e.g., T) has an original raw object with properties,
        // find the property symbol matching this key literal and push its raw ts.Type for reuse.
        try {
            const parentParams = parentContext.getParameters();
            // Attempt to find a suitable raw object among parent parameters (generic T or direct source object)
            for (const paramName of parentParams) {
                const rawObj = parentContext.getOriginalType(paramName);
                if (!rawObj) continue;
                const tc: ts.TypeChecker | undefined = (this.childNodeParser as any).typeChecker;
                if (!tc) continue;
                const props = tc.getPropertiesOfType(rawObj);
                const keyName = (key as any).getValue ? (key as any).getValue().toString() : undefined;
                if (!keyName) continue;
                const propSym = props.find((p: any) => p.getName && p.getName() === keyName);
                if (propSym) {
                    const decl = propSym.valueDeclaration ?? propSym.declarations?.[0];
                    if (decl) {
                        const propRaw = tc.getTypeOfSymbolAtLocation(propSym, decl);
                        if (propRaw) {
                            subContext.pushOriginalType(paramName, rawObj);
                            subContext.pushOriginalType(keyName, propRaw);
                            if ((subContext as any).pushOriginalTypeOrdered) {
                                (subContext as any).pushOriginalTypeOrdered(propRaw);
                            }
                        }
                    }
                }
            }
        } catch {
            /* ignore */
        }

        return subContext;
    }
}
