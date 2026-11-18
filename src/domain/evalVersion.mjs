//評估器版本之單一定義(規則 R-REC-33、R-REC-34): 評估環境之鍵(domain.mjs 之 envKey)與附算 / 補算之評估器之指紋(fillKeys.mjs 之 evaluatorFpOf)共用此值;
//  共同儲存區之重產(pickStore.mjs)經 evaluatorFpOf 取得同一個值 —— 附算與共同儲存區之 current 標示用同一判準, 不留兩處定義
//  評估器之行為改變而 src/eval 與 src/cli/eval.mjs 之內容不足以呈現者(例: 評估器所匯入之其他套件之改版造成之數字變動)⇒ 調高此值:
//    節點 id 隨 envKey 改變(全樹重算), 且既有之附算 / 補算之值全部過時(共同儲存區之 postfit 之 current 為 false 直至重算)
//  本檔不得匯入領域或儲存區之模組(避免循環匯入; 兩者皆匯入本檔)

/**
 * 評估器版本(整數);改變者使評估環境之鍵與附算 / 補算之評估器之指紋皆改變
 *
 * @type {Number}
 */
let EVAL_VERSION = 2

export { EVAL_VERSION }
