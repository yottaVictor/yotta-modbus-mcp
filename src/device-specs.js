/**
 * Yotta 設備型號規格資料庫
 * 來源：moduleData.js（轉為 ES Module）
 * 
 * 格式：
 *   { do, di, ai, ao } 各為 { count, baseAddress } 或 null（不具備該 I/O）
 */

export const deviceSpecs = {
    // A-10X 系列
    "A-1010": { do: { count: 4, baseAddress: 16 }, di: null, ai: { count: 8, baseAddress: 0 }, ao: { count: 2, baseAddress: 16 } },
    "A-1012": { do: { count: 2, baseAddress: 16 }, di: { count: 2, baseAddress: 0 }, ai: { count: 4, baseAddress: 0 }, ao: { count: 2, baseAddress: 16 } },
    "A-1013": { do: { count: 2, baseAddress: 16 }, di: { count: 2, baseAddress: 0 }, ai: { count: 4, baseAddress: 0 }, ao: { count: 2, baseAddress: 16 } },
    "A-1019": { do: null, di: { count: 4, baseAddress: 0 }, ai: { count: 8, baseAddress: 0 }, ao: null },
    "A-1036": { do: null, di: null, ai: null, ao: { count: 6, baseAddress: 16 } },
    "A-1038": { do: null, di: null, ai: null, ao: { count: 8, baseAddress: 16 } },
    "A-1051": { do: null, di: { count: 16, baseAddress: 0 }, ai: null, ao: null },
    "A-1055": { do: { count: 8, baseAddress: 16 }, di: { count: 8, baseAddress: 0 }, ai: null, ao: null },
    "A-1057": { do: { count: 12, baseAddress: 16 }, di: null, ai: null, ao: null },
    "A-1060": { do: { count: 4, baseAddress: 16 }, di: { count: 8, baseAddress: 0 }, ai: null, ao: null },
    "A-1068": { do: { count: 8, baseAddress: 16 }, di: null, ai: null, ao: null },

    // A-12X 系列
    "A-1212": { do: { count: 2, baseAddress: 16 }, di: { count: 2, baseAddress: 0 }, ai: { count: 4, baseAddress: 0 }, ao: { count: 2, baseAddress: 16 } },
    "A-1219": { do: null, di: { count: 4, baseAddress: 0 }, ai: { count: 8, baseAddress: 0 }, ao: null },
    "A-1251": { do: null, di: { count: 16, baseAddress: 0 }, ai: null, ao: null },
    "A-1255": { do: { count: 4, baseAddress: 16 }, di: { count: 8, baseAddress: 0 }, ai: { count: 4, baseAddress: 0 }, ao: null },
    "A-1260": { do: { count: 4, baseAddress: 16 }, di: { count: 7, baseAddress: 0 }, ai: { count: 4, baseAddress: 0 }, ao: null },
    "A-1269": { do: { count: 8, baseAddress: 16 }, di: null, ai: { count: 4, baseAddress: 0 }, ao: null },

    // A-18X 系列
    "A-1812": { do: null, di: { count: 2, baseAddress: 0 }, ai: { count: 4, baseAddress: 0 }, ao: { count: 2, baseAddress: 16 } },
    "A-1819": { do: null, di: null, ai: { count: 8, baseAddress: 0 }, ao: null },
    "A-1851": { do: null, di: { count: 16, baseAddress: 0 }, ai: null, ao: null },
    "A-1855": { do: { count: 4, baseAddress: 16 }, di: { count: 8, baseAddress: 0 }, ai: null, ao: null },
    "A-1869": { do: { count: 8, baseAddress: 16 }, di: null, ai: null, ao: null },

    // A-19X 系列
    "A-1955": { do: { count: 4, baseAddress: 16 }, di: { count: 5, baseAddress: 0 }, ai: null, ao: null },

    // Controller 系列
    "A-5188": { do: { count: 4, baseAddress: 16 }, di: { count: 8, baseAddress: 0 }, ai: null, ao: null },
    "A-5189": { do: { count: 4, baseAddress: 16 }, di: { count: 4, baseAddress: 0 }, ai: { count: 4, baseAddress: 100 }, ao: null },
    "A-5190": { do: { count: 2, baseAddress: 0 }, di: { count: 2, baseAddress: 0 }, ai: { count: 4, baseAddress: 0 }, ao: { count: 2, baseAddress: 0 } },
    "A-5191": { do: { count: 10, baseAddress: 16 }, di: { count: 16, baseAddress: 0 }, ai: { count: 4, baseAddress: 200 }, ao: null },
};

/**
 * 依型號查詢規格
 * @param {string} model - 型號，例如 "A-1812"
 * @returns {object|null} 規格物件或 null（找不到）
 */
export function lookupSpec(model) {
    // 標準化：移除 + 符號與 S 後綴做寬鬆比對
    const key = model.toUpperCase().replace(/\+$/, '').replace(/S$/, '');
    return deviceSpecs[key] ?? deviceSpecs[model.toUpperCase()] ?? null;
}
