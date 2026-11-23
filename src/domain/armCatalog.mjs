import { nextArmId, nextLayerId } from '../engineApi.mjs'
import { objReq, isPlain, badInput, boolOpt } from '../arsi/inputs.mjs'

//臂目錄之條目與審定參數(規則 R-ARM-1 ~ R-ARM-3)
//  三層分工: 節點與做夢「提」(節點文件 conclusion.armProposals、做夢文件 guidance.armProposals), 主控「審」(tools/armDecide.mjs), 通過者下一輪加入目錄
//  提案帳、審定、擴充與生效目錄之合成皆為引擎之治理(w-recursi 之 rsi.governance; 正本在 <狀態根>/governance/):
//    proposals.json(提案帳)+ PROPOSALS.md(引擎渲染; 做夢與主控讀)、extensions.json(通過之新臂 / 新層 / 修訂 / 停用; 審定之提交點)
//    生效之目錄 = 基底(arms/base.json; node tools/buildCatalog.mjs 產生)+ 擴充; 供 agent 閱讀者另寫為 arms/catalog.json(看板重產時; src/domain/domain.mjs)
//  本檔只留本專案之約定: 臂之標準形(mkArm)、提案之正規化(proposalOf)、主控之命令列 → 引擎之審定參數(decideArgsOf)

/**
 * 臂 id 之格式正規式(層代號大寫字母 + 2~3 位數流水號 + 底線 + 英數名,如 `A12_Name`)
 *
 * @type {RegExp}
 */
let ARM_ID = /^[A-Z]\d{2,3}_[A-Za-z][A-Za-z0-9]*$/

//mkArm, 目錄內一個臂之標準形(與基底相同之欄位; 落成名依 id 而定: 可選者 = 算子 add:<id> + 載體 <id>)
/**
 * 建立目錄內一個臂之標準形(狀態恆為 proposed;可選者落成為算子 add:<id> 加載體 <id>,不可選者為 manual)
 * opt 非一般物件、id 不合臂 id 之格式、selectable 給了而不是 true / false ⇒ 同步拋 invalid opt…: must be …(固定訊息、不帶輸入值);selectable 未給(undefined、null)= 不可選。
 *
 * @param {Object} opt 輸入設定物件
 * @param {String} opt.id 輸入臂 id,首字為層代號
 * @param {Number} [opt.n] 輸入臂序號
 * @param {String} opt.title 輸入臂名稱
 * @param {String} [opt.desc] 輸入臂說明,未給則不寫入
 * @param {Boolean} [opt.selectable] 輸入是否可選,僅 true 視為可選
 * @param {Object} [opt.grid] 輸入格點,有給才寫入
 * @returns {Object} 回傳臂物件,含 id、n、layer、title、desc、status、selectable、realize、grid
 * @example
 * let arm = mkArm({ id: 'A12_Demo', title: '示範臂', selectable: true })
 */
let mkArm = (opt) => {
    //輸入之檢測(跨套件規格 V4、K5、§5.1; R-EV-54; 純函數 ⇒ 同步拋固定訊息): opt 須為一般物件; id 須為臂 id 之格式(ARM_ID); selectable 給了須為 true / false(原: 僅 `=== true` 為可選 ⇒ `'true'`、`1` 靜默成不可選; id 為 undefined 時於 `id[0]` 拋原生 TypeError)
    let o = objReq(opt, 'opt')
    if (typeof o.id !== 'string' || !ARM_ID.test(o.id)) {
        throw badInput('opt.id', 'an arm id such as A12_Name')
    }
    let { id, n, title, desc, grid } = o
    let selectable = boolOpt(o.selectable, false, 'opt.selectable')
    let a = { id, n, layer: id[0], title }
    if (desc) {
        a.desc = desc
    }
    a.status = 'proposed'
    a.selectable = selectable === true
    a.realize = realizeOf(id, a.selectable)
    if (grid) {
        a.grid = grid
    }
    return a
}

//realizeOf, 臂之落成名: 可選者 = 算子 add:<id> + 載體 <id>; 不可選者為 manual(mkArm 與 decideArgsOf 之修訂共用; 修訂之 id 取自現行目錄之既有臂, 不再核對 ARM_ID 之格式)
let realizeOf = (id, selectable) => (selectable
    ? [{ kind: 'operator', op: `add:${id}` }, { kind: 'carrier', name: id }]
    : [{ kind: 'manual', how: '不派給節點(量尺 / 迴圈自身 / 須改評估器)' }])

//proposalOf, 節點或做夢之一筆提案 → 引擎之提案形 { kind, arm, layer, title, mechanism, boundary, evidence, sources }(純函數)
//  非字串之選配欄當成未給、sources 只留字串(引擎之 checkProposals 對型別不合者整筆不收); 必填欄(類別、機制、名稱、所指之臂)由引擎核對, 不合者列於 propose 之 invalid
/**
 * 將節點或做夢之一筆提案正規化為引擎之提案形(純函數)
 *
 * @param {Object} p 輸入提案物件,讀取 kind、arm、layer、title、mechanism、boundary、evidence、sources
 * @returns {Object} 回傳 { kind, arm, layer, title, mechanism, boundary, evidence, sources },非字串之選配欄為 null,sources 只留字串
 * @example
 * let q = proposalOf({ kind: 'new', title: '示範', mechanism: '說明', sources: ['a'] })
 */
let proposalOf = (p) => {
    let str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    return { kind: p.kind, arm: str(p.arm), layer: str(p.layer), title: str(p.title), mechanism: typeof p.mechanism === 'string' ? p.mechanism.trim() : p.mechanism, boundary: str(p.boundary), evidence: str(p.evidence), sources: Array.isArray(p.sources) ? p.sources.filter((s) => typeof s === 'string') : [] }
}

//decideArgsOf, 主控之審定參數: tools/armDecide.mjs 之命令列 → 引擎之 rsi.governance.decide(id, args)(純函數)
//  p = 提案帳之該筆; o = { accept, why, by, name, layer, armId, title, desc, selectable(布林或 undefined), noGrid, catalog(現行之生效目錄) }
//  回 { args } 或 { error }(參數不足或不合; 未呼叫引擎)
//  新臂(new): 臂 id 由本專案配(<層代號><全目錄之下一個流水號>_<英數名>; 引擎之 nextArmId)—— 落成名(算子 add:<id>、載體 <id>)依 id 而定, 故不交引擎依 name 配號
//    (w-recursi 1.0.10 起落成名可用佔位 {id} 由引擎於鎖內配號(issue #144); 本專案只有單一主控審定、無併行配號之虞, 沿用現行作法);
//    層 = --layer 或提案所寫之層之首字; 名稱 = --title 或提案之名; 說明 = --desc 或提案之 mechanism; 預設可選
//  新層(layer): 代號 = --layer(單一大寫字母)或下一個未用之字母; 層名 = 名稱(另給 --desc 者接「:說明」)
//  修訂(revise): 只改明給之欄, 說明恆給(未給 --desc ⇒ 提案之 mechanism = 修訂後之定義); 可選與否有變者連落成名一起給;
//    --no-grid ⇒ grid {}(空格點視同無; w-recursi 1.0.10 起修訂可用 null 刪鍵, 但既有之擴充已有空格點之項、讀取端一律把空格點視同無, 故沿用 {})
//  停用(retire): 無須另給(理由 = why; 引擎改為 blocked、不可選, 留在目錄)
/**
 * 將主控之審定命令列參數轉為引擎 rsi.governance.decide(id, args) 之參數(純函數)
 *
 * 未通過(accept 非 true)或無提案時只回基本參數;依提案 kind(new、layer、revise)組出新臂、新層或修訂之內容。
 * 輸入之檢測:opt 非一般物件、accept / selectable / noGrid 給了而非 true / false(字串 'true'、'false'、數字皆非布林)⇒ 回 { error: 'invalid opt.<鍵>: must be …' }(未呼叫引擎;固定訊息、不帶輸入值)。
 *
 * @param {Object} p 輸入提案帳之該筆提案
 * @param {Object} [o={}] 輸入審定設定物件,預設{}
 * @param {Boolean} [o.accept] 輸入是否通過
 * @param {String} [o.why] 輸入理由
 * @param {String} [o.by='主控'] 輸入審定者,預設'主控'
 * @param {String} [o.name] 輸入新臂之英數名
 * @param {String} [o.layer] 輸入層代號
 * @param {String} [o.armId] 輸入新臂 id
 * @param {String} [o.title] 輸入名稱
 * @param {String} [o.desc] 輸入說明
 * @param {Boolean} [o.selectable] 輸入是否可選
 * @param {Boolean} [o.noGrid] 輸入是否清空格點(修訂用)
 * @param {Object} [o.catalog] 輸入現行生效目錄
 * @returns {Object} 回傳 { args } 或 { error }(參數不足或不合)
 * @example
 * let r = decideArgsOf({ kind: 'new', title: '示範', mechanism: '說明', layer: 'A' }, { accept: true, name: 'Demo', catalog })
 */
let decideArgsOf = (p, opt = {}) => {
    //輸入之檢測(跨套件規格 V4、K5; R-EV-54 ①; 回 { error } 者通知): opt 須為一般物件(null、undefined 視為 {}); accept(通過與否)、selectable(可選與否)、noGrid 給了須為 true / false(原: `accept: 'true'` ⇒ 引擎「不採」、`selectable: 'false'` ⇒ 可選; 與意圖相反); 未給(undefined 或 null)= accept false、selectable 預設可選、noGrid false
    let o = opt === undefined || opt === null ? {} : opt
    if (!isPlain(o)) {
        return { error: 'invalid opt: must be an object' }
    }
    for (let k of ['accept', 'selectable', 'noGrid']) {
        if (o[k] !== undefined && o[k] !== null && o[k] !== true && o[k] !== false) {
            return { error: `invalid opt.${k}: must be a boolean` }
        }
    }
    let args = { accept: o.accept === true, why: o.why, by: o.by || '主控' }
    if (!args.accept || !p) {
        return { args }
    }
    let cat = o.catalog || { layers: {}, arms: [] }
    let layers = cat.layers || {}
    let title = o.title || p.title
    if (p.kind === 'new') {
        let armId = typeof o.armId === 'string' ? o.armId : null
        if (armId && (!ARM_ID.test(armId) || layers[armId[0]] === undefined)) {
            return { error: `--arm-id 須為 <既有之層代號><流水號>_<英數名>(收到 ${armId};現有層: ${Object.keys(layers).join(' ')})` }
        }
        if (!armId) {
            let layer = typeof o.layer === 'string' ? o.layer : (p.layer && /^[A-Z]/.test(p.layer) ? p.layer[0] : null)
            if (typeof o.name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(o.name) || typeof layer !== 'string' || layers[layer] === undefined) {
                return { error: `新臂須給 --name <英數名> 與既有之層 --layer(提案所寫之層: ${p.layer || '未寫'};現有層: ${Object.keys(layers).join(' ')})` }
            }
            armId = nextArmId(cat, layer, o.name)
        }
        //n 由引擎配(全目錄之最大序號 + 1)
        let arm = mkArm({ id: armId, title, desc: o.desc || p.mechanism, selectable: o.selectable !== false })
        delete arm.n
        return { args: { ...args, arm } }
    }
    if (p.kind === 'layer') {
        let id = typeof o.layer === 'string' && /^[A-Z]$/.test(o.layer) ? o.layer : nextLayerId(cat)
        return { args: { ...args, layer: { id, title: o.desc ? `${title}:${o.desc}` : title } } }
    }
    if (p.kind === 'revise') {
        let cur = (cat.arms || []).find((a) => a.id === p.arm)
        if (!cur) {
            return { error: `所指之臂 ${p.arm} 不在目錄` }
        }
        let patch = { ...(o.title ? { title: o.title } : {}), desc: o.desc || p.mechanism }
        if (typeof o.selectable === 'boolean' && o.selectable !== (cur.selectable === true)) {
            patch.selectable = o.selectable
            patch.realize = realizeOf(cur.id, o.selectable)
        }
        if (o.noGrid === true) {
            patch.grid = {}
        }
        return { args: { ...args, arm: patch } }
    }
    return { args }
}

export { ARM_ID, mkArm, proposalOf, decideArgsOf }
