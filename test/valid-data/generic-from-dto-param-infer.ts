// Test exercising parameter-only infer pattern: method(param: infer U): any
// Expected behavior: Schema should include properties of parameter type used in conditional transformation (similar to toJSON return inference)

type Dtoify<T> = T extends { fromDto(param: infer U): any } ? U : T;

class UserDto {
    name!: string;
    age!: number;
}

class Wrapper<T> {
    value!: T;
    fromDto(param: T): any {
        return param;
    }
}

export type GenericFromDtoParamInfer = Dtoify<Wrapper<UserDto>>;
