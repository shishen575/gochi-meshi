// ジャンルの自動判定。サーバー(Node)とブラウザの両方で同じ規則を使う。
(function (root) {
  const GENRES = ["ラーメン","寿司・海鮮","肉料理","定食・食堂","カレー","うどん・そば","郷土料理","カフェ・スイーツ","居酒屋","その他"];
  // 先に当たった規則が勝つ（「焼鳥居酒屋」は肉料理、「そば処 定食」はうどん・そば、のように具体的なものを先に）
  const NAME_RULES = [
    ["ラーメン", /ラーメン|らーめん|拉麺|ラァメン|中華そば|つけ麺|つけめん|家系|二郎|担々麺|担担麺|油そば|まぜそば|町中華|ramen/i],
    ["うどん・そば", /うどん|饂飩|そば|蕎麦|ざるそ|udon|soba/i],
    ["カレー", /カレー|カリー|curry|スープカレー/i],
    ["寿司・海鮮", /寿司|鮨|すし|スシ|海鮮|刺身|鮮魚|魚介|漁師|sushi/i],
    ["肉料理", /焼肉|焼き肉|ホルモン|ステーキ|ハンバーグ|とんかつ|トンカツ|焼鳥|焼き鳥|やきとり|やきとん|串カツ|串揚げ|ジンギスカン|しゃぶしゃぶ|すき焼|牛タン|唐揚|からあげ|ローストビーフ|ハンバーガー|バーガー|ミート|肉/i],
    ["カフェ・スイーツ", /カフェ|cafe|珈琲|コーヒー|喫茶|ベーカリー|パン屋|パティスリー|ケーキ|スイーツ|アイス|ジェラート|クレープ|洋菓子|和菓子|甘味|パフェ|ドーナツ|タピオカ|ティー|bakery/i],
    ["居酒屋", /居酒屋|酒場|大衆酒場|立ち飲み|立呑|バル|bar\b|ビアホール|ビアガーデン|酒蔵|焼酎|日本酒|ダイニング/i],
    ["郷土料理", /郷土|もんじゃ|お好み焼|お好みやき|たこ焼|たこやき|沖縄料理|ほうとう|きりたんぽ|もつ鍋|水炊き|うなぎ|鰻|ひつまぶし|ちゃんぽん|皿うどん|ぶっかけ/i],
    ["定食・食堂", /定食|食堂|めし屋|めし処|ごはん|ご飯|ランチ|丼|どんぶり|弁当|おにぎり|洋食|キッチン|レストラン/i]
  ];
  // OpenStreetMap の cuisine / amenity、Google Places の primaryType から
  const TAG_RULES = [
    ["ラーメン", /ramen|noodle|chinese/i],
    ["うどん・そば", /udon|soba/i],
    ["カレー", /curry|indian/i],
    ["寿司・海鮮", /sushi|seafood|fish/i],
    ["肉料理", /steak|barbecue|bbq|yakiniku|burger|chicken|meat|grill|korean_barbecue|yakitori|tonkatsu/i],
    ["カフェ・スイーツ", /cafe|coffee|ice_cream|dessert|bakery|pastry|cake|sweets|tea|donut|confectionery/i],
    ["居酒屋", /izakaya|pub|bar|beer|wine_bar/i],
    ["郷土料理", /regional|okonomiyaki|takoyaki|monja|unagi|eel/i],
    ["定食・食堂", /japanese|donburi|teishoku|diner/i]
  ];
  function guessGenre(opts) {
    const text = String((opts && opts.name) || '');
    for (const [g, re] of NAME_RULES) if (re.test(text)) return g;
    const tags = String((opts && opts.tags) || '');
    if (tags) for (const [g, re] of TAG_RULES) if (re.test(tags)) return g;
    const extra = String((opts && opts.comment) || '');
    if (extra) for (const [g, re] of NAME_RULES.slice(0, 5)) if (re.test(extra)) return g;   // コメントは具体的な料理名だけ見る
    return '';
  }
  const api = { GENRES, guessGenre };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Genre = api;
})(typeof self !== 'undefined' ? self : this);
