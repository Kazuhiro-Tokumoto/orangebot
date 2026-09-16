/**
 * パスキーの画面側。
 *
 * 束ねる道具を入れたくないので、素の WebAuthn API を直接叩く小さな script を
 * そのまま埋め込む。サーバとの遣り取りは JSON で、値は全て base64url にしてある。
 *
 * 使う側は、次の id を持つ要素を置く。
 *   #passkey-register  登録ボタン（設定画面）
 *   #passkey-nickname  名前の入力欄（任意）
 *   #passkey-login     ログインボタン（ログイン画面）
 *   #passkey-status    経過と失敗の理由を出す場所
 */
export const PASSKEY_SCRIPT = String.raw`
(function () {
  var status = document.getElementById('passkey-status');

  function say(message, bad) {
    if (!status) return;
    status.textContent = message;
    status.className = bad ? 'field-hint bad-text' : 'field-hint';
  }

  function toBuffer(value) {
    var padded = value.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4 !== 0) padded += '=';
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function toBase64Url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () {
        return { ok: false, reason: '応答を読み取れませんでした' };
      });
    });
  }

  function decodeIds(list) {
    (list || []).forEach(function (item) {
      item.id = toBuffer(item.id);
    });
  }

  function describe(error) {
    if (error && error.name === 'NotAllowedError') return '操作が取り消されました';
    if (error && error.name === 'InvalidStateError') return 'この端末は既に登録されています';
    if (error && error.message) return error.message;
    return 'パスキーを扱えませんでした';
  }

  var registerButton = document.getElementById('passkey-register');
  if (registerButton) {
    registerButton.addEventListener('click', function () {
      registerButton.disabled = true;
      say('端末の確認を待っています…');

      postJson('/settings/passkeys/options', {})
        .then(function (start) {
          if (!start.ok) throw new Error(start.reason);
          var options = start.options;
          options.challenge = toBuffer(options.challenge);
          options.user.id = toBuffer(options.user.id);
          decodeIds(options.excludeCredentials);

          return navigator.credentials.create({ publicKey: options }).then(function (credential) {
            var nickname = document.getElementById('passkey-nickname');
            return postJson('/settings/passkeys', {
              challengeId: start.challengeId,
              nickname: nickname ? nickname.value : '',
              response: {
                id: credential.id,
                rawId: toBase64Url(credential.rawId),
                type: credential.type,
                clientExtensionResults: credential.getClientExtensionResults(),
                authenticatorAttachment: credential.authenticatorAttachment || undefined,
                response: {
                  clientDataJSON: toBase64Url(credential.response.clientDataJSON),
                  attestationObject: toBase64Url(credential.response.attestationObject),
                  transports: credential.response.getTransports
                    ? credential.response.getTransports()
                    : [],
                },
              },
            });
          });
        })
        .then(function (done) {
          if (!done.ok) throw new Error(done.reason);
          window.location.assign('/settings');
        })
        .catch(function (error) {
          registerButton.disabled = false;
          say(describe(error), true);
        });
    });
  }

  var loginButton = document.getElementById('passkey-login');
  if (loginButton) {
    if (typeof window.PublicKeyCredential !== 'function') {
      loginButton.disabled = true;
      say('この browser はパスキーに対応していません', true);
    }

    loginButton.addEventListener('click', function () {
      loginButton.disabled = true;
      say('端末の確認を待っています…');

      postJson('/login/passkey/options', {})
        .then(function (start) {
          if (!start.ok) throw new Error(start.reason);
          var options = start.options;
          options.challenge = toBuffer(options.challenge);
          decodeIds(options.allowCredentials);

          return navigator.credentials.get({ publicKey: options }).then(function (credential) {
            return postJson('/login/passkey', {
              challengeId: start.challengeId,
              response: {
                id: credential.id,
                rawId: toBase64Url(credential.rawId),
                type: credential.type,
                clientExtensionResults: credential.getClientExtensionResults(),
                authenticatorAttachment: credential.authenticatorAttachment || undefined,
                response: {
                  clientDataJSON: toBase64Url(credential.response.clientDataJSON),
                  authenticatorData: toBase64Url(credential.response.authenticatorData),
                  signature: toBase64Url(credential.response.signature),
                  userHandle: credential.response.userHandle
                    ? toBase64Url(credential.response.userHandle)
                    : undefined,
                },
              },
            });
          });
        })
        .then(function (done) {
          if (!done.ok) throw new Error(done.reason);
          window.location.assign(done.redirect);
        })
        .catch(function (error) {
          loginButton.disabled = false;
          say(describe(error), true);
        });
    });
  }
})();
`;
