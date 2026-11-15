import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  secretKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  income(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  incomeSalt(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  attestationPath(context: __compactRuntime.WitnessContext<Ledger, PS>,
                  leaf_0: Uint8Array): [PS, { leaf: Uint8Array,
                                              path: { sibling: { field: bigint },
                                                      goes_left: boolean
                                                    }[]
                                            }];
}

export type ImpureCircuits<PS> = {
  attest(context: __compactRuntime.CircuitContext<PS>, leaf_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  createListing(context: __compactRuntime.CircuitContext<PS>,
                listingId_0: Uint8Array,
                rent_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  apply(context: __compactRuntime.CircuitContext<PS>, listingId_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type ProvableCircuits<PS> = {
  attest(context: __compactRuntime.CircuitContext<PS>, leaf_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  createListing(context: __compactRuntime.CircuitContext<PS>,
                listingId_0: Uint8Array,
                rent_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  apply(context: __compactRuntime.CircuitContext<PS>, listingId_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type PureCircuits = {
  publicKey(sk_0: Uint8Array): Uint8Array;
  attestationLeaf(inc_0: bigint, tenantPk_0: Uint8Array, salt_0: Uint8Array): Uint8Array;
  applicationId(listingId_0: Uint8Array, sk_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  publicKey(context: __compactRuntime.CircuitContext<PS>, sk_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  attestationLeaf(context: __compactRuntime.CircuitContext<PS>,
                  inc_0: bigint,
                  tenantPk_0: Uint8Array,
                  salt_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  applicationId(context: __compactRuntime.CircuitContext<PS>,
                listingId_0: Uint8Array,
                sk_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  attest(context: __compactRuntime.CircuitContext<PS>, leaf_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  createListing(context: __compactRuntime.CircuitContext<PS>,
                listingId_0: Uint8Array,
                rent_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  apply(context: __compactRuntime.CircuitContext<PS>, listingId_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type Ledger = {
  readonly issuerPk: Uint8Array;
  attestations: {
    isFull(): boolean;
    checkRoot(rt_0: { field: bigint }): boolean;
    root(): __compactRuntime.MerkleTreeDigest;
    firstFree(): bigint;
    pathForLeaf(index_0: bigint, leaf_0: Uint8Array): __compactRuntime.MerkleTreePath<Uint8Array>;
    findPathForLeaf(leaf_0: Uint8Array): __compactRuntime.MerkleTreePath<Uint8Array> | undefined;
    history(): Iterator<__compactRuntime.MerkleTreeDigest>
  };
  readonly attestationCount: bigint;
  listings: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  applications: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
}

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
export declare const circuitSignatures: __compactRuntime.CircuitSignatures;
export declare const declaredInterfaces: __compactRuntime.DeclaredInterfaces;
