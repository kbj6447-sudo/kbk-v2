var cachedToken = null;
var tokenExpiresAt = 0;

async function getTossAccessToken() {
  var now = Date.now();

  // 아직 유효한 토큰이면 재사용
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  var clientId = process.env.TOSS_CLIENT_ID;
  var clientSecret = process.env.TOSS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'TOSS_CLIENT_ID 또는 TOSS_CLIENT_SECRET 환경변수가 없습니다.'
    );
  }

  var basicAuth = Buffer
    .from(clientId + ':' + clientSecret)
    .toString('base64');

  var response = await fetch(
    'https://openapi.tossinvest.com/oauth2/token',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + basicAuth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: 'grant_type=client_credentials'
    }
  );

  var payload = await response.json().catch(function () {
    return null;
  });

  if (!response.ok) {
    console.error('[TOSS TOKEN ERROR]', {
      status: response.status,
      payload: payload
    });

    throw new Error(
      '토스 액세스 토큰 발급 실패 HTTP ' + response.status
    );
  }

  if (!payload || !payload.access_token) {
    console.error('[TOSS TOKEN INVALID RESPONSE]', payload);
    throw new Error('토스 access_token이 응답에 없습니다.');
  }

  cachedToken = payload.access_token;

  var expiresIn = Number(payload.expires_in || 3600);

  tokenExpiresAt =
    Date.now() + expiresIn * 1000;

  return cachedToken;
}

module.exports = {
  getTossAccessToken: getTossAccessToken
};
