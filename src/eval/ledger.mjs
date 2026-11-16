import fs from 'fs'
import path from 'path'
import { P, bytesAs, assertIntrinsics } from './intrinsics.mjs'

const { Float64ArrayCtor, TypedArrayPrototypeGetLength } = P


//訂單帳本之載入: 讀 ledgerBuild 產出之二進位欄, 並建「依出場棒排序」之輔助欄(供「某時點以前已結之單」之統計以二分搜尋取得)
//  回傳 L: { meta, n(策略數), nBars, off/ent/ext/pnl(依進場棒升冪之逐單欄), xoff/xExt/xPnlCum/xWinCum(依出場棒升冪之已結單欄; Cum 為策略內前綴和), 靜態欄, fac(因子序列欄; 用到才讀), seriesNames / ser(外部序列之名稱與欄; 欄用到才讀) }
//readBin, 讀檔為定型陣列(規則 R-EV-35 ②): fac / ser 為延遲讀取, 首次讀取發生於挑選函數呼叫 ctx.factor / ctx.series 之期間
//  ⇒ 只用載入時擷取之參照(bytesAs: 擷取之建構子與 set; 不經 ArrayBuffer.prototype.slice 與其 species 建構子); 延遲讀取之兩欄傳入擷取之建構子(不以全域名稱取用)
//  且延遲讀取之前先比對內建物件(lazyCheck): Node 之 fs.readFileSync 本身會經可被改寫之 %TypedArray%.prototype.byteLength 與 Buffer.allocUnsafe 取得讀入用之緩衝區,
//  被改時拒讀(拋 EVAL_INTEGRITY; 未讀入, 下次取用再試)—— 讀檔為同步, 比對通過後至讀完之間不會執行模組之程式
//  其餘各欄於 loadLedger 呼叫當下讀入(命令列於讀帳本前先比對內建物件; 見 src/cli/eval.mjs)
let readBin = (fp, Ctor) => bytesAs(fs.readFileSync(fp), Ctor)

/**
 * 載入訂單帳本資料夾(由 buildLedger 產出之 meta.json 與二進位欄), 並建立依出場棒排序之已結單欄
 * K 線欄 px.f64 有此檔者須恰為 5 × K 棒數個 float64(否則拋 invalid px.f64: must be … 之錯誤, 請重建帳本); 無此檔(舊帳本)者 px 為 null
 * 因子序列欄 fac 為延遲讀取(首次存取 L.fac 才載入; 無檔者為 null); 外部序列欄 ser 同(首次存取 L.ser 才載入; 無檔者為 null), 其名稱 seriesNames 取自 meta.seriesNames(舊帳本無此欄者為空陣列)
 *
 * @param {String} dir 輸入帳本資料夾路徑
 * @returns {Object} 回傳帳本物件L, 含 dir、meta、n(策略數)、nBars、barsPerDay、逐單欄(off、ent、ext、pnl)、靜態欄(mode、tp、sl、nKeys、lv、fitNt、cls、keyOff、keyIdx、keyNames、px、keySym、keyTh、keyOr; px、keySym、keyTh、keyOr 於無檔時為 null)、依出場棒升冪之已結單欄(xoff、xExt、xPnlCum、xWinCum)、延遲讀取之 fac 與外部序列(seriesNames、延遲讀取之 ser)
 * @example
 * let L = loadLedger('./data/ledger/eval')
 */
let loadLedger = (dir) => {
    //入口比對(規則 R-EV-35 ②): 讀帳本之一般寫法(JSON.parse、push、sort、length 等)須在比對之後; 呼叫端之前可能已載入模組
    assertIntrinsics('ledger-load')
    let meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
    //px, K 線欄(開高低收量逐棒五個值; px[i * 5 + 0..4]; 規則 R-EV-36): 有此檔者須恰為 5 × K 棒數個 float64(位元組數 = 5 × 8 × nBars), 否則拋錯請重建帳本
    //  截短之欄使 ctx.market / api.market 於缺尾處回 NaN 而不拋錯; 無此檔(舊帳本)者為 null(取用時拋「帳本無 K 線欄」); 因子欄與外部序列欄為延遲讀取, 其長度於取用時核對(evalCore.mjs 之 factorAt / seriesAt)
    //  核對之位元組數即實際使用之位元組(讀入一次、核對該份、再轉為 Float64Array; 不先 stat 再讀: 兩次之間檔案被重建者核對與使用不同份; 非 8 之倍數者不致由定型陣列建構子拋出不指明欄名之錯誤)
    //  meta.nBars 須為非負整數(小數、數字字串使乘積可通過核對而於其後建評估器時拋不指明欄名之錯誤); 錯誤訊息不帶值與路徑(跨套件規格〈輸入參數之檢測機制〉§6 V19、V20)
    let fpPx = path.join(dir, 'px.f64')
    let px = null
    if (fs.existsSync(fpPx)) {
        let bufPx = fs.readFileSync(fpPx)
        if (!Number.isInteger(meta.nBars) || meta.nBars < 0 || TypedArrayPrototypeGetLength(bufPx) !== 40 * meta.nBars) {
            throw new Error('invalid px.f64: must be 5 * meta.nBars float64 values (請重建帳本)')
        }
        px = bytesAs(bufPx, Float64Array)
    }
    let L = {
        dir,
        meta,
        n: meta.nStrategies,
        nBars: meta.nBars,
        barsPerDay: Math.round(24 / meta.barHours),
        off: readBin(path.join(dir, 'off.u32'), Uint32Array),
        ent: readBin(path.join(dir, 'ent.i32'), Int32Array),
        ext: readBin(path.join(dir, 'ext.i32'), Int32Array),
        pnl: readBin(path.join(dir, 'pnl.f32'), Float32Array),
        mode: readBin(path.join(dir, 'mode.i8'), Int8Array),
        tp: readBin(path.join(dir, 'tp.f32'), Float32Array),
        sl: readBin(path.join(dir, 'sl.f32'), Float32Array),
        nKeys: readBin(path.join(dir, 'nKeys.u8'), Uint8Array),
        lv: readBin(path.join(dir, 'lv.i32'), Int32Array),
        fitNt: readBin(path.join(dir, 'fitNt.i32'), Int32Array),
        cls: readBin(path.join(dir, 'cls.u8'), Uint8Array),
        keyOff: readBin(path.join(dir, 'keyOff.u32'), Uint32Array),
        keyIdx: readBin(path.join(dir, 'keyIdx.u16'), Uint16Array),
        keyNames: meta.keyNames,
        px,
        //進場規則之各條件(與 keyIdx 逐格對齊; 規則 R-EV-29); 舊帳本無此三欄者為 null
        keySym: fs.existsSync(path.join(dir, 'keySym.i8')) ? readBin(path.join(dir, 'keySym.i8'), Int8Array) : null,
        keyTh: fs.existsSync(path.join(dir, 'keyTh.f64')) ? readBin(path.join(dir, 'keyTh.f64'), Float64Array) : null,
        keyOr: fs.existsSync(path.join(dir, 'keyOr.u8')) ? readBin(path.join(dir, 'keyOr.u8'), Uint8Array) : null,
    }
    //fac, 因子序列欄(fac[ki * nBars + i]; 約 60 MB): 用到才讀 —— 未呼叫 ctx.factor 之評估不付載入之時間與記憶體; 舊帳本無此欄者為 null
    let fpFac = path.join(dir, 'fac.f64')
    let fac
    Object.defineProperty(L, 'fac', {
        enumerable: false,
        configurable: true,
        get: () => {
            if (fac === undefined) {
                assertIntrinsics('ledger-read')
                fac = fs.existsSync(fpFac) ? readBin(fpFac, Float64ArrayCtor) : null
            }
            return fac
        },
    })
    //seriesNames / ser, 外部序列(規則 R-EV-34; 選配; ser[si * nBars + i], 缺值 NaN): 名稱取自 meta.seriesNames(舊帳本無此欄者為空陣列), 欄同 fac 用到才讀; 無檔者為 null
    //  存在而型態不合(非字串陣列)者拋錯, 不當成未建入(免得有序列欄而名稱被靜默忽略)
    if (meta.seriesNames !== undefined && meta.seriesNames !== null && !(Array.isArray(meta.seriesNames) && meta.seriesNames.every((x) => typeof x === 'string'))) {
        throw new Error(`帳本 meta.seriesNames 之格式不合(須為名稱字串陣列; 請重建帳本): ${dir}`)
    }
    L.seriesNames = Array.isArray(meta.seriesNames) ? meta.seriesNames : []
    let fpSer = path.join(dir, 'ser.f64')
    let ser
    Object.defineProperty(L, 'ser', {
        enumerable: false,
        configurable: true,
        get: () => {
            if (ser === undefined) {
                assertIntrinsics('ledger-read')
                if (fs.existsSync(fpSer)) {
                    let sz = fs.statSync(fpSer).size
                    if (sz % 8 !== 0) {
                        throw new Error(`帳本之外部序列欄 ser.f64 之位元組數(${sz})非 8 之倍數(請重建帳本): ${fpSer}`)
                    }
                    ser = readBin(fpSer, Float64ArrayCtor)
                }
                else {
                    ser = null
                }
            }
            return ser
        },
    })
    //依出場棒排序之已結單欄
    let n = L.n
    let xoff = new Uint32Array(n + 1)
    let nClosed = 0
    for (let j = 0; j < L.ext.length; j++) {
        if (L.ext[j] >= 0) {
            nClosed++
        }
    }
    let xExt = new Int32Array(nClosed)
    let xPnlCum = new Float64Array(nClosed)
    let xWinCum = new Int32Array(nClosed)
    let p = 0
    let tmp = []
    for (let s = 0; s < n; s++) {
        xoff[s] = p
        tmp.length = 0
        for (let j = L.off[s]; j < L.off[s + 1]; j++) {
            if (L.ext[j] >= 0) {
                tmp.push(j)
            }
        }
        tmp.sort((a, b) => L.ext[a] - L.ext[b] || a - b)
        let cp = 0
        let cw = 0
        for (let j of tmp) {
            cp += L.pnl[j]
            cw += L.pnl[j] > 0 ? 1 : 0
            xExt[p] = L.ext[j]
            xPnlCum[p] = cp
            xWinCum[p] = cw
            p++
        }
    }
    xoff[n] = p
    L.xoff = xoff
    L.xExt = xExt
    L.xPnlCum = xPnlCum
    L.xWinCum = xWinCum
    return L
}

//ids, 策略序號 → 策略檔名(需要時才讀)
/**
 * 讀取帳本資料夾內之 ids.json, 取得策略序號對應之策略檔名陣列
 *
 * @param {String} dir 輸入帳本資料夾路徑
 * @returns {Array} 回傳策略檔名陣列, 以策略序號為索引
 * @example
 * let ids = loadIds('./data/ledger/eval')
 */
let loadIds = (dir) => {
    assertIntrinsics('ledger-load')
    return JSON.parse(fs.readFileSync(path.join(dir, 'ids.json'), 'utf8'))
}


export { loadLedger, loadIds }
export default loadLedger
