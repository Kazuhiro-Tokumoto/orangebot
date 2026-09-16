import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * テスト用の偽の認証器。
 *
 * 本物の端末が作るのと同じ形の応答を組み立てて、鍵で署名する。
 * これがあると、パスキーの登録とログインを browser 抜きで端から端まで通せる。
 *
 * 仕様は WebAuthn Level 3 の 6.1 (authenticator data) と 6.5.4 (none 形式の attestation)。
 */

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

const AAGUID = Buffer.alloc(16, 0);

function b64u(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function sha256(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest();
}

function counterBytes(counter: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(counter, 0);
  return buffer;
}

export interface FakeAuthenticatorOptions {
  readonly rpId: string;
  readonly origin: string;
  /** 登録時に渡した利用者の識別子。ログインの応答にそのまま載る。 */
  readonly userHandle?: string;
}

export class FakeAuthenticator {
  readonly credentialId: Buffer;
  private readonly rpIdHash: Buffer;
  private readonly privateKey;
  private readonly cosePublicKey: Buffer;

  constructor(private readonly options: FakeAuthenticatorOptions) {
    this.credentialId = randomBytes(16);
    this.rpIdHash = sha256(options.rpId);

    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;

    const jwk = pair.publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x ?? '', 'base64url');
    const y = Buffer.from(jwk.y ?? '', 'base64url');

    // COSE_Key の ES256。1=kty(EC2) 3=alg(-7) -1=crv(P-256) -2=x -3=y
    const key = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(x)],
      [-3, new Uint8Array(y)],
    ]);
    this.cosePublicKey = Buffer.from(isoCBOR.encode(key));
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.options.origin, crossOrigin: false }),
      'utf8',
    );
  }

  /** 登録の応答。attestation は none 形式。 */
  register(challenge: string, counter = 0): RegistrationResponseJSON {
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(this.credentialId.length, 0);

    const authData = Buffer.concat([
      this.rpIdHash,
      Buffer.from([UP | UV | BE | BS | AT]),
      counterBytes(counter),
      AAGUID,
      credentialIdLength,
      this.credentialId,
      this.cosePublicKey,
    ]);

    const attestation = new Map<string, unknown>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', new Uint8Array(authData)],
    ]);

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', challenge)),
        attestationObject: b64u(
          Buffer.from(isoCBOR.encode(attestation as Parameters<typeof isoCBOR.encode>[0])),
        ),
        transports: ['internal', 'hybrid'],
      },
    };
  }

  /** ログインの応答。authData と clientDataJSON のハッシュを繋いだものに署名する。 */
  authenticate(challenge: string, counter = 0): AuthenticationResponseJSON {
    const authData = Buffer.concat([
      this.rpIdHash,
      Buffer.from([UP | UV | BE | BS]),
      counterBytes(counter),
    ]);
    const clientDataJSON = this.clientData('webauthn.get', challenge);
    const signature = createSign('sha256')
      .update(Buffer.concat([authData, sha256(clientDataJSON)]))
      .sign(this.privateKey);

    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(this.options.userHandle === undefined
          ? {}
          : { userHandle: Buffer.from(this.options.userHandle, 'utf8').toString('base64url') }),
      },
    };
  }
}
