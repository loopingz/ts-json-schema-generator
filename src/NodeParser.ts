import stringify from "safe-stable-stringify";
import type ts from "typescript";
import type { BaseType } from "./Type/BaseType.js";
import type { ReferenceType } from "./Type/ReferenceType.js";
import { getKey } from "./Utils/nodeKey.js";

export class Context {
    private cacheKey: string | null = null;
    private arguments: BaseType[] = [];
    private parameters: string[] = [];
    private reference?: ts.Node;
    private defaultArgument = new Map<string, BaseType>();
    // Keep a mapping to original (non transformed) TypeScript types so that
    // conditional type evaluation (extends checks, property access etc.) can
    // refer back to full, unstripped type information when needed.
    private originalTypes = new Map<string, ts.Type>();
    // Ordered list of original types aligned with argument positions (before parameter names are known)
    private originalTypesInOrder: ts.Type[] = [];
    // Deterministic concrete raw binding for each generic parameter once a non-parameter,
    // method-bearing (or enriched) raw has been identified (e.g. LeafWithToJSON for T in Jsonify<T>).
    // This survives nested conditional evaluations where other heuristics might lose the link.
    private concreteRaw = new Map<string, ts.Type>();

    public constructor(reference?: ts.Node) {
        this.reference = reference;
    }

    public pushArgument(argumentType: BaseType): void {
        this.arguments.push(argumentType);
        this.cacheKey = null;
    }

    public pushParameter(parameterName: string): void {
        this.parameters.push(parameterName);
    }

    /** Store original (raw) TypeScript type for a given parameter */
    public pushOriginalType(parameterName: string, type: ts.Type): void {
        this.originalTypes.set(parameterName, type);
    }

    /** Push original type by argument order before parameter names are bound */
    public pushOriginalTypeOrdered(type: ts.Type): void {
        this.originalTypesInOrder.push(type);
    }

    /** Get original (raw) TypeScript type if available */
    public getOriginalType(parameterName: string): ts.Type | undefined {
        return this.originalTypes.get(parameterName);
    }

    public setDefault(parameterName: string, argumentType: BaseType): void {
        this.defaultArgument.set(parameterName, argumentType);
    }

    public getCacheKey(): string {
        if (this.cacheKey == null) {
            this.cacheKey = stringify([
                this.reference ? getKey(this.reference, this) : "",
                this.arguments.map((argument) => argument?.getId()),
            ]);
        }
        return this.cacheKey;
    }

    public getArgument(parameterName: string): BaseType {
        const index: number = this.parameters.indexOf(parameterName);

        if ((index < 0 || !this.arguments[index]) && this.defaultArgument.has(parameterName)) {
            return this.defaultArgument.get(parameterName)!;
        }

        return this.arguments[index];
    }

    public getParameters(): readonly string[] {
        return this.parameters;
    }
    public getArguments(): readonly BaseType[] {
        return this.arguments;
    }

    /** Get original type by argument index (used when later binding parameter names) */
    public getOriginalTypeByIndex(index: number): ts.Type | undefined {
        return this.originalTypesInOrder[index];
    }

    /** Record a deterministic concrete raw for a generic parameter */
    public pushConcreteRaw(parameterName: string, type: ts.Type): void {
        // Only store if not a naked type parameter
        if ((type.flags & (1 << 1)) === 0) {
            // TypeFlags.TypeParameter = 1<<1 but keep runtime independent of enum import
            this.concreteRaw.set(parameterName, type);
        } else {
            this.concreteRaw.set(parameterName, type); // still store; consumer can decide
        }
    }
    public getConcreteRaw(parameterName: string): ts.Type | undefined {
        return this.concreteRaw.get(parameterName);
    }
    public getAllConcreteRaws(): Map<string, ts.Type> {
        return this.concreteRaw;
    }

    public getReference(): ts.Node | undefined {
        return this.reference;
    }
}

export interface NodeParser {
    createType(node: ts.Node, context: Context, reference?: ReferenceType): BaseType;
}
