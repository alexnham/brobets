import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "./matching-idl.json";
import { deployment } from "./matching";
import { TRADE_DISCRIMINATORS, TREASURY_AUTHORITY } from "./wallet";

const sponsored = [
  "propose_wager",
  "match_wager",
  "cancel_wager",
  "claim_wager",
];

// Trust boundary: the sponsor's signature spends its SOL, so it signs only a transaction
// that is exactly one wager action, buy or sell by `user`, optionally preceded by creating
// the user's own token accounts (and, on a buy, the fixed treasury account). With no other
// instruction allowed, the cost is bounded to the two-signature base fee plus fixed-size
// account rent.
// shortcut: no per-user or global spending budget, add before any non-devnet release.
export function sponsorSign(raw: Uint8Array, sponsor: Keypair, user: PublicKey) {
  const fail = (why: string): never => {
    throw Error(`Not sponsorable: ${why}`);
  };
  const d = deployment(),
    tx = Transaction.from(raw),
    payer = sponsor.publicKey;
  if (!tx.feePayer?.equals(payer)) fail("fee payer");
  const setup = tx.instructions.slice(0, -1),
    main = tx.instructions.at(-1);
  if (!main || !main.programId.equals(d.program)) return fail("instruction");
  const usdc = new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT!),
    ata = (mint: PublicKey, owner: PublicKey) =>
      getAssociatedTokenAddressSync(mint, owner),
    head = main.data.subarray(0, 8),
    trade = (["buy", "sell"] as const).find((a) =>
      Buffer.from(TRADE_DISCRIMINATORS[a]).equals(head),
    );
  const creatable: [PublicKey, PublicKey][] = trade
    ? [
        [user, usdc],
        [user, d.mint],
        ...(trade === "buy"
          ? ([[TREASURY_AUTHORITY, usdc]] as [PublicKey, PublicKey][])
          : []),
      ]
    : [[user, d.mint]];
  if (setup.length > creatable.length) fail("instruction count");
  for (const ix of setup) {
    if (
      !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) ||
      ix.data.length !== 1 ||
      ix.data[0] !== 1 ||
      !creatable.some(([owner, mint]) => {
        const want = [
          payer,
          ata(mint, owner),
          owner,
          mint,
          SystemProgram.programId,
          TOKEN_PROGRAM_ID,
        ];
        return (
          ix.keys.length === want.length &&
          ix.keys.every((k, i) => k.pubkey.equals(want[i]))
        );
      })
    )
      fail("token account creation");
  }
  if (trade) {
    // Every account is fixed, so the sponsor cannot appear anywhere in the trade itself.
    const want = [
      user,
      d.vault,
      usdc,
      d.mint,
      d.derive(Buffer.from("reserve"), d.vault.toBytes()),
      ata(usdc, user),
      ata(d.mint, user),
      TOKEN_PROGRAM_ID,
      ...(trade === "buy" ? [ata(usdc, TREASURY_AUTHORITY)] : []),
    ];
    if (
      main.data.length !== 16 ||
      main.keys.length !== want.length ||
      !main.keys.every((k, i) => k.pubkey.equals(want[i]))
    )
      fail("trade accounts");
  } else checkWager(main, d, user, payer, fail);
  // Decoded signer flags are per transaction, so the signer set is checked here: exactly
  // the sponsor and the player, which also fixes the fee at two signatures.
  const message = tx.compileMessage();
  if (
    message.header.numRequiredSignatures !== 2 ||
    !message.accountKeys[1].equals(user)
  )
    fail("signers");
  tx.partialSign(sponsor);
  // Also proves the user signed this exact message.
  if (!tx.verifySignatures()) fail("user signature");
  return tx.serialize();
}

function checkWager(
  main: TransactionInstruction,
  d: ReturnType<typeof deployment>,
  user: PublicKey,
  payer: PublicKey,
  fail: (why: string) => never,
) {
  const abi = idl.instructions.find(
    (i) =>
      sponsored.includes(i.name) &&
      Buffer.from(i.discriminator).equals(main.data.subarray(0, 8)),
  );
  if (!abi || main.keys.length !== abi.accounts.length)
    return fail("instruction");
  const fixed: Record<string, PublicKey> = {
    payer,
    maker: user,
    taker: user,
    user,
    token_mint: d.mint,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  };
  abi.accounts.forEach((a, i) => {
    const k = main.keys[i],
      want = fixed[a.name];
    // The sponsor may appear only as the payer of rent, or as the account that gets it
    // back (the program pins rent_payer to the payer recorded on the wager).
    if (
      want
        ? !k.pubkey.equals(want)
        : k.pubkey.equals(payer) && a.name !== "rent_payer"
    )
      fail(`account ${a.name}`);
  });
}
