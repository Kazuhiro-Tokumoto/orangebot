import { describe, expect, it } from 'vitest';
import {
  AddressError,
  addressFromPrivateKey,
  decodeAddress,
  encodeAddress,
  inspectDestination,
  xOnlyPublicKey,
} from './address.js';
import {
  COIN_TYPE,
  MAINNET_COIN_TYPE_PENDING,
  accountPath,
  addressFromXpub,
  createMnemonic,
  deriveAccountXpub,
  deriveAddress,
  deriveAddresses,
  derivationPath,
  derivePrivateKey,
  isValidMnemonic,
  mnemonicToSeed,
  normalizeMnemonic,
} from './seed.js';
import {
  DEFAULT_KDF,
  MIN_PASSPHRASE_LENGTH,
  VaultError,
  changePassphrase,
  openMnemonic,
  readHeader,
  sealMnemonic,
} from './vault.js';

/** SPEC §6.5 の検証済みベクタ。 */
const VECTORS = [
  {
    priv: '3bea301b132570f53a193a6542940305ac1e6b343249425433febf3c01d3f8f8',
    xonly: '0830053b6ac7f7b10243a8058fb5d9bc3ccdec622deadaa9da7f885f16dedc2e',
    mainnet: 'oag1qpqcq2wm2clmmzqjr4qzcldwehs7vmmrz9h4d42w607y979k7mshq9ve7jv',
    testnet: 'toag1qpqcq2wm2clmmzqjr4qzcldwehs7vmmrz9h4d42w607y979k7mshqwraqde',
  },
  {
    priv: '5487aaeb0f711bf0dee2cf7b97ea24f28037617dc5ff2f45d095a14ebf231f22',
    xonly: '5b528dd539132944eee4387dbf81aee1c65699d1154993a55d1c181c76b3e53e',
    mainnet: 'oag1qtdfgm4fezv55fmhy8p7mlqdwu8r9dxw3z4ye8f2arsvpca4nu5lq34qtxp',
    testnet: 'toag1qtdfgm4fezv55fmhy8p7mlqdwu8r9dxw3z4ye8f2arsvpca4nu5lq66y4e5',
  },
  {
    priv: '01119d84272af17d8d957f160f3117bbcc769c2a95e9f8398c546ca24c6a52d8',
    xonly: '1ed0a9a1dc8ab784f5f38a869d8479f0ce476eea093883f0e718c566cabe823e',
    mainnet: 'oag1qrmg2ngwu32mcfa0n32rfmpre7r8ywmh2pyug8u88rrzkdj47sglqc68mtx',
    testnet: 'toag1qrmg2ngwu32mcfa0n32rfmpre7r8ywmh2pyug8u88rrzkdj47sglqn4r95n',
  },
] as const;

/** BIP39 の標準テストベクタにある控え。 */
const KNOWN_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('アドレス（SPEC §6.5 のベクタ）', () => {
  it.each(VECTORS)('秘密鍵 $priv から正しい x-only 公開鍵が出る', (vector) => {
    const priv = Buffer.from(vector.priv, 'hex');
    expect(Buffer.from(xOnlyPublicKey(priv)).toString('hex')).toBe(vector.xonly);
  });

  it.each(VECTORS)('mainnet のアドレスが一致する', (vector) => {
    expect(addressFromPrivateKey('mainnet', Buffer.from(vector.priv, 'hex'))).toBe(vector.mainnet);
  });

  it.each(VECTORS)('testnet のアドレスが一致する', (vector) => {
    expect(addressFromPrivateKey('testnet', Buffer.from(vector.priv, 'hex'))).toBe(vector.testnet);
  });

  it('仕様どおりの長さになる', () => {
    const priv = Buffer.from(VECTORS[0].priv, 'hex');
    expect(addressFromPrivateKey('mainnet', priv)).toHaveLength(63);
    expect(addressFromPrivateKey('testnet', priv)).toHaveLength(64);
    expect(addressFromPrivateKey('regtest', priv)).toHaveLength(64);
  });
});

describe('アドレスの読み取り', () => {
  it('往復できる', () => {
    const payload = Buffer.from(VECTORS[0].xonly, 'hex');
    const decoded = decodeAddress('mainnet', encodeAddress('mainnet', payload));
    expect(decoded.version).toBe(0);
    expect(Buffer.from(decoded.payload).toString('hex')).toBe(VECTORS[0].xonly);
  });

  it('ネットワークが違うアドレスを断る', () => {
    expect(() => decodeAddress('mainnet', VECTORS[0].testnet)).toThrow(AddressError);
    expect(() => decodeAddress('testnet', VECTORS[0].mainnet)).toThrow(/testnet のアドレスでは/);
  });

  it('検査符号が壊れていれば断る', () => {
    const broken = `${VECTORS[0].mainnet.slice(0, -1)}q`;
    expect(() => decodeAddress('mainnet', broken)).toThrow(AddressError);
  });

  it('1 文字変えただけでも断る', () => {
    const tampered = VECTORS[0].mainnet.replace('oag1qp', 'oag1qr');
    expect(() => decodeAddress('mainnet', tampered)).toThrow(AddressError);
  });

  it('version 0 は 32 バイトでなければ作れない', () => {
    expect(() => encodeAddress('mainnet', Buffer.alloc(20))).toThrow(AddressError);
  });

  it('未知の版数は警告付きで通す', () => {
    const future = encodeAddress('mainnet', Buffer.alloc(32, 7), 1);
    const result = inspectDestination('mainnet', future);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toContain('資金を失います');
  });

  it('version 0 なら警告は出ない', () => {
    const result = inspectDestination('mainnet', VECTORS[0].mainnet);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toBeUndefined();
  });

  it('壊れたアドレスは理由を返して断る', () => {
    const result = inspectDestination('mainnet', 'not-an-address');
    expect(result.ok).toBe(false);
  });
});

describe('コインタイプ', () => {
  it('mainnet は SLIP-0044 へ申請中の 1033', () => {
    expect(COIN_TYPE.mainnet).toBe(1033);
    // 番号が確定したらこの印を false にする。
    expect(MAINNET_COIN_TYPE_PENDING).toBe(true);
  });

  it('testnet と regtest は全コイン共通の 1', () => {
    expect(COIN_TYPE.testnet).toBe(1);
    expect(COIN_TYPE.regtest).toBe(1);
  });

  it('経路が BIP44 の形になる', () => {
    expect(derivationPath('mainnet', { index: 0 })).toBe("m/44'/1033'/0'/0/0");
    expect(derivationPath('mainnet', { index: 5, change: 1, account: 2 })).toBe(
      "m/44'/1033'/2'/1/5",
    );
    expect(derivationPath('testnet', { index: 0 })).toBe("m/44'/1'/0'/0/0");
    expect(accountPath('mainnet')).toBe("m/44'/1033'/0'");
  });
});

describe('控えと鍵導出', () => {
  it('12 語を作る', () => {
    const mnemonic = createMnemonic();
    expect(mnemonic.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(mnemonic)).toBe(true);
  });

  it('毎回違う控えになる', () => {
    expect(new Set(Array.from({ length: 20 }, createMnemonic)).size).toBe(20);
  });

  it('語が間違っていれば弾く', () => {
    expect(isValidMnemonic('abandon abandon abandon')).toBe(false);
    expect(isValidMnemonic(KNOWN_MNEMONIC.replace('about', 'abandon'))).toBe(false);
    expect(() => mnemonicToSeed('not a real mnemonic at all')).toThrow();
  });

  it('大文字や余分な空白を吸収する', () => {
    expect(normalizeMnemonic('  ABANDON   about  ')).toBe('abandon about');
    expect(isValidMnemonic(KNOWN_MNEMONIC.toUpperCase())).toBe(true);
  });

  it('同じ控えからは常に同じアドレスが出る', () => {
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const first = deriveAddress(seed, 'mainnet', { index: 0 });
    const again = deriveAddress(mnemonicToSeed(KNOWN_MNEMONIC), 'mainnet', { index: 0 });
    expect(first.address).toBe(again.address);
    expect(first.path).toBe("m/44'/1033'/0'/0/0");
  });

  it('index ごとに別のアドレスになる', () => {
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const addresses = deriveAddresses(seed, 'mainnet', { count: 20 }).map((a) => a.address);
    expect(new Set(addresses).size).toBe(20);
    for (const address of addresses) expect(address.startsWith('oag1')).toBe(true);
  });

  it('受取用とお釣り用で別のアドレスになる', () => {
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    expect(deriveAddress(seed, 'mainnet', { index: 0, change: 0 }).address).not.toBe(
      deriveAddress(seed, 'mainnet', { index: 0, change: 1 }).address,
    );
  });

  it('ネットワークが違えば別の鍵になる', () => {
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const main = derivePrivateKey(seed, 'mainnet', { index: 0 });
    const test = derivePrivateKey(seed, 'testnet', { index: 0 });
    expect(Buffer.from(main).toString('hex')).not.toBe(Buffer.from(test).toString('hex'));
  });

  it('追加パスフレーズを変えると別のウォレットになる', () => {
    // 打ち間違えても失敗にはならず、単に残高 0 の別ウォレットが出てくる。
    const a = deriveAddress(mnemonicToSeed(KNOWN_MNEMONIC, ''), 'mainnet', { index: 0 });
    const b = deriveAddress(mnemonicToSeed(KNOWN_MNEMONIC, 'typo'), 'mainnet', { index: 0 });
    expect(a.address).not.toBe(b.address);
  });

  it('拡張公開鍵だけで同じ受取アドレスを作れる', () => {
    const seed = mnemonicToSeed(KNOWN_MNEMONIC);
    const xpub = deriveAccountXpub(seed, 'mainnet');
    for (let index = 0; index < 5; index += 1) {
      expect(addressFromXpub(xpub, 'mainnet', { index })).toBe(
        deriveAddress(seed, 'mainnet', { index }).address,
      );
    }
  });
});

describe('パスフレーズによる保管', () => {
  const PASSPHRASE = 'correct horse battery staple';
  // テストを現実的な速さに保つため、封じるときだけ軽いパラメータを使う。
  const FAST = { memoryCost: 8192, timeCost: 2, parallelism: 1 };

  it('封じて取り出せる', async () => {
    const blob = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    expect(await openMnemonic(blob, PASSPHRASE)).toBe(KNOWN_MNEMONIC);
  });

  it('控えが平文で残らない', async () => {
    const blob = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    expect(blob.toString('utf8')).not.toContain('abandon');
    expect(blob.toString('utf8')).not.toContain('about');
  });

  it('毎回違う暗号文になる', async () => {
    const a = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    const b = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    expect(a.equals(b)).toBe(false);
  });

  it('パスフレーズが違えば断る', async () => {
    const blob = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    await expect(openMnemonic(blob, 'wrong passphrase')).rejects.toThrow(VaultError);
  });

  it('暗号文を書き換えれば断る', async () => {
    const blob = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0x01;
    await expect(openMnemonic(blob, PASSPHRASE)).rejects.toThrow(VaultError);
  });

  it('パラメータを書き換えても断る', async () => {
    // ヘッダは認証付きデータなので、ここを触れば復号が通らない。
    const blob = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    blob.writeUInt32BE(1024, 7);
    await expect(openMnemonic(blob, PASSPHRASE)).rejects.toThrow(VaultError);
  });

  it('パスフレーズ違いと改竄を区別しない', async () => {
    const blob = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;

    const wrong = await openMnemonic(blob, 'wrong passphrase').catch((e: Error) => e.message);
    const broken = await openMnemonic(tampered, PASSPHRASE).catch((e: Error) => e.message);
    expect(wrong).toBe(broken);
  });

  it('短いパスフレーズを断る', async () => {
    await expect(sealMnemonic(KNOWN_MNEMONIC, 'short', { kdf: FAST })).rejects.toThrow(
      new RegExp(String(MIN_PASSPHRASE_LENGTH)),
    );
  });

  it('控えが不正なら封じない', async () => {
    await expect(sealMnemonic('not a mnemonic', PASSPHRASE, { kdf: FAST })).rejects.toThrow(
      VaultError,
    );
  });

  it('ヘッダからパラメータを読める', async () => {
    const blob = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    const head = readHeader(blob);
    expect(head.version).toBe(1);
    expect(head.kdf).toEqual(FAST);
    expect(head.salt).toHaveLength(16);
  });

  it('他人の形式は読まない', () => {
    expect(() => readHeader(Buffer.alloc(64))).toThrow(VaultError);
  });

  it('パスフレーズを付け替えられる', async () => {
    const blob = await sealMnemonic(KNOWN_MNEMONIC, PASSPHRASE, { kdf: FAST });
    const next = await changePassphrase(blob, PASSPHRASE, 'a different passphrase', { kdf: FAST });

    expect(await openMnemonic(next, 'a different passphrase')).toBe(KNOWN_MNEMONIC);
    await expect(openMnemonic(next, PASSPHRASE)).rejects.toThrow(VaultError);
  });

  it('既定のパラメータは仕様のウォレットより強い', () => {
    // SPEC §16.2 は m=64MiB, t=3。こちらは約 1 秒かかるよう引き上げてある。
    expect(DEFAULT_KDF.memoryCost).toBeGreaterThanOrEqual(65536);
    expect(DEFAULT_KDF.timeCost).toBeGreaterThanOrEqual(3);
  });
});
