export type MyType<T> = T extends { toJSON(): infer U } ? U : T;
