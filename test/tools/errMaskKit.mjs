//測試用(派工結果之 error 欄與同源輸出之遮罩; unit-errMask、unit-errMaskSites 共用): 假金鑰與「金鑰之前段 / 後段殘留」之判定
//  假金鑰僅供測試(不是真實之金鑰); 金鑰檔所列 = K1、K2(OPENCODE_GO_KEYS)與一個用途不明之長值(OTHER)
export let K1 = 'oc_sk_TESTKEY00000001'
export let K2 = 'oc_sk_TESTKEY00000002'
export let OTHER = 'OTHER_TOKEN_VALUE'

//leaksOf, 任一把金鑰之 6 字元以上之前段 / 後段殘留於 s(截斷先於遮罩時留下之前段; 後段為被截去前段者)者之清單
export let leaksOf = (s, keys = [K1, K2, OTHER]) => keys.filter((k) => {
    for (let n = 6; n <= k.length; n++) {
        for (let i = 0; i + n <= k.length; i++) {
            if (i === 0 && s.includes(k.slice(0, n))) {
                return true
            }
            if (i + n === k.length && s.includes(k.slice(i))) {
                return true
            }
        }
    }
    return false
})
