export type Json<T> = T extends { toJSON(): infer U } ? U : T;

export class MyObject {
    public a: string;
    public b: number;
    public c: boolean;
    public d: Date;
    public e: MyObject;
    public f: MyObject | undefined;

    public toJSON(): Json<this> {
        return this;
    }
}
