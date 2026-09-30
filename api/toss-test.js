var tossToken = require('../lib/tossToken');

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');

  try {
    var token = await tossToken.getTossAccessToken();

    var response = await fetch(
      'https://openapi.tossinvest.com/api/v1/prices?symbols=TSLA',
      {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/json'
        }
      }
    );

    var payload = await response.json().catch(function () {
      return null;
    });

    return res.status(response.status).json({
      ok: response.ok,
      status: response.status,
      toss: payload
    });

  } catch (error) {
    console.error('[TOSS TEST ERROR]', error);

    return res.status(500).json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : 'Toss API test failed'
    });
  }
};
