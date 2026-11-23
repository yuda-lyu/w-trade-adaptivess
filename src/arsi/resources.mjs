import os from 'os'
import getTrace from 'wsemi/src/getTrace.mjs'
import { optOf } from './inputs.mjs'
import { rsiNumOf } from './rsiNums.mjs'


//資源監看與資源閘(通用; 不含領域用語): 讓使用端依自身設備給定 CPU 與記憶體之上限, 迴圈據以決定何時可再起一項工作
//  createResourceMonitor({ cpuMax, ramUsedMaxGB, cpuStart, ramStartGB, sampleSec, pollSec, maxWaitSec, read, log })
//    cpuMax        全機 CPU 使用率之上限(%); 取樣超過者計入 overCpu(統計用)
//    ramUsedMaxGB  全機已用記憶體之上限(GB); 取樣超過者計入 overRam
//    cpuStart      起新工作之門檻(%; 預設 cpuMax − 15): 最近一次取樣 ≤ 此值才放行(留餘裕給即將起之工作)
//    ramStartGB    起新工作之門檻(GB; 預設 ramUsedMaxGB − 8)
//    sampleSec     取樣間隔(秒; 預設 5); pollSec 等待時之重查間隔(預設 10); maxWaitSec 最長等待(預設 1800), 逾時放行並記 forced
//    jitter        等待時重查間隔之隨機抖動比例(0 ~ 1; 預設 0): 多個行程各自等同一門檻時, 抖動使其不同時放行(rand 可注入; 預設 Math.random)
//    read          取樣函數(依賴注入; 預設讀本機): () → { cpuTimes: { idle, total }, ramUsedGB }; 測試可換假資料
//  回 { start(), stop(), sample(), wait(tag), stats(), reset() }
//    start / stop  開始 / 停止背景取樣(unref, 不阻止行程結束)
//    wait(tag)     資源閘: 等到最近取樣在門檻內才回 { waitedSec, forced }; 未設任何上限者立即放行
//    stats()       { samples, cpuMean, cpuPeak, ramPeakGB, overCpu, overRam, waits, waitedSec, forced, limits, series[{ t(分鐘), cpuMean, cpuMax, ramMaxGB }] }
/**
 * 讀取本機 CPU 時間與已用記憶體(createResourceMonitor 之預設取樣函數)
 *
 * @returns {Object} 回傳 { cpuTimes: { idle, total }, ramUsedGB },cpuTimes 為各核心累計時間之加總,ramUsedGB 為已用記憶體(GB)
 * @example
 * let r = osRead()
 * console.log(Object.keys(r))
 * // => [ 'cpuTimes', 'ramUsedGB' ]
 */
let osRead = () => {
    let idle = 0
    let total = 0
    for (let c of os.cpus()) {
        for (let k of Object.keys(c.times)) {
            total += c.times[k]
        }
        idle += c.times.idle
    }
    return { cpuTimes: { idle, total }, ramUsedGB: (os.totalmem() - os.freemem()) / 1073741824 }
}

/**
 * 建立資源監看與資源閘(依 CPU 與記憶體上限決定何時可再起一項工作)
 *
 * 未設任何上限(cpuMax、ramUsedMaxGB、cpuStart、ramStartGB 皆未給)時,wait 立即放行。
 *
 * @param {Object} [opt={}] 輸入設定物件,預設{}
 * @param {Number} [opt.cpuMax] 輸入全機 CPU 使用率上限(%),取樣超過者計入 overCpu
 * @param {Number} [opt.ramUsedMaxGB] 輸入全機已用記憶體上限(GB),取樣超過者計入 overRam
 * @param {Number} [opt.cpuStart] 輸入起新工作之 CPU 門檻(%),預設為 Math.max(1, cpuMax - 15)
 * @param {Number} [opt.ramStartGB] 輸入起新工作之記憶體門檻(GB),預設為 Math.max(1, ramUsedMaxGB - 8)
 * @param {Number} [opt.sampleSec=5] 輸入取樣間隔秒數,預設5
 * @param {Number} [opt.pollSec=10] 輸入等待時之重查間隔秒數,預設10
 * @param {Number} [opt.maxWaitSec=1800] 輸入最長等待秒數,逾時放行並記 forced,預設1800
 * @param {Number} [opt.jitter=0] 輸入等待重查間隔之隨機抖動比例(0 至 1),預設0
 * @param {Function} [opt.read] 輸入取樣函數,形式 () → { cpuTimes: { idle, total }, ramUsedGB },預設為 osRead
 * @param {Function} [opt.log] 輸入記錄函數,預設空函數
 * @param {Function} [opt.sleep] 輸入睡眠函數,形式 (ms) → Promise,預設為 setTimeout 版本
 * @param {Function} [opt.rand] 輸入亂數函數,預設Math.random
 * @param {Function} [opt.onTrace=null] 輸入觀察回調(跨套件規格〈計時器相關函數之觀察回調與測試〉;沿用 wsemi 之 getTrace),形式 (e) => {},e 為凍結之事件物件 { type, ... },於事件發生當下同步呼叫(拋錯與回傳之 rejection 忽略;未給時不組事件物件;stop 之後背景取樣之事件不再發出),預設null。事件:
 *   'start' { sampleSec }(開始背景取樣;已在取樣者不發)、'stop' {}(停止背景取樣;未在取樣者不發)、'sample' { cpu(%; 第一次取樣無 CPU 值為 null), ramUsedGB }(每取一次樣)、
 *   'wait-pass' { tag, waitedSec, forced: false, limited }(資源閘放行;未設任何上限者 limited 為 false、立即放行)、'wait-block' { tag, cpu, ramUsedGB }(最近取樣在門檻之外,開始等待;一次等待只發一次)、
 *   'wait-poll' { tag, cpu, ramUsedGB, sleepMs }(每次重查之前;sleepMs 為即將睡眠之毫秒數,已含抖動)、'wait-forced' { tag, waitedSec, forced: true }(等待逾最長時間,放行)
 * @returns {Object} 回傳物件,含方法 start(開始背景取樣)、stop(停止背景取樣)、sample(取一次樣)、wait(tag)(資源閘,回傳 { waitedSec, forced })、stats(取得統計)、reset(統計歸零)
 * @example
 * let mon = createResourceMonitor({ cpuMax: 90, ramUsedMaxGB: 24 })
 * mon.start()
 * let r = await mon.wait('node')
 * console.log(r.forced)
 * mon.stop()
 */
let createResourceMonitor = (opt0 = {}) => {
    //opt 本身(跨套件規格 V4、§5.1; R-EV-54; 工廠 ⇒ 同步拋固定訊息): null、undefined 視為 {}; 非一般物件拋 invalid opt: must be an object(原: null 於讀鍵時拋原生 TypeError)
    //  各鍵之值(排程第 606 項; R-EV-55; K3、K4、K7): 與 settings.resources.* 同一口徑(rsiNumOf 與 RESOURCE_NUMS 之種類): 數字與數字字串轉為數值後才使用; 無效(非數字、NaN、無限、超出值域)與未給 ⇒ 用預設
    //  cpuMax、ramUsedMaxGB、cpuStart、ramStartGB 為有限數(同改前); sampleSec、pollSec 為正數(秒; 換成毫秒不超過 2147483647); maxWaitSec 為非負數(0 = 不等待、逾時立即放行)
    let opt = optOf(opt0)
    let cpuMax = rsiNumOf(opt.cpuMax, 'num')
    let ramMax = rsiNumOf(opt.ramUsedMaxGB, 'num')
    let cpuStart0 = rsiNumOf(opt.cpuStart, 'num')
    let ramStart0 = rsiNumOf(opt.ramStartGB, 'num')
    let cpuStart = cpuStart0 !== null ? cpuStart0 : (cpuMax !== null ? Math.max(1, cpuMax - 15) : null)
    let ramStart = ramStart0 !== null ? ramStart0 : (ramMax !== null ? Math.max(1, ramMax - 8) : null)
    let sampleSec0 = rsiNumOf(opt.sampleSec, 'timerSec')
    let pollSec0 = rsiNumOf(opt.pollSec, 'timerSec')
    let maxWaitSec0 = rsiNumOf(opt.maxWaitSec, 'waitSec')
    let sampleSec = sampleSec0 !== null ? sampleSec0 : 5
    let pollSec = pollSec0 !== null ? pollSec0 : 10
    let maxWaitSec = maxWaitSec0 !== null ? maxWaitSec0 : 1800
    let num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    let read = typeof opt.read === 'function' ? opt.read : osRead
    let log = typeof opt.log === 'function' ? opt.log : () => {}
    let sleep = typeof opt.sleep === 'function' ? opt.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    let jitter = num(opt.jitter) === null ? 0 : Math.max(0, Math.min(1, opt.jitter))
    let rand = typeof opt.rand === 'function' ? opt.rand : Math.random
    //觀察回調(opt.onTrace; wsemi getTrace): 未給 ⇒ null、不組事件物件
    let trace = getTrace(opt)

    let prev = null
    let last = null
    let timer = null
    let st = { samples: 0, cpuSum: 0, cpuPeak: 0, ramPeakGB: 0, overCpu: 0, overRam: 0, waits: 0, waitedSec: 0, forced: 0 }
    let series = []

    //sample, 取一次樣(CPU 使用率 = 與前一次取樣之間之非閒置比例; 第一次取樣無 CPU 值)
    let sample = () => {
        let r = read()
        let cpu = null
        if (prev && r.cpuTimes.total > prev.cpuTimes.total) {
            let dT = r.cpuTimes.total - prev.cpuTimes.total
            let dI = r.cpuTimes.idle - prev.cpuTimes.idle
            cpu = Math.max(0, Math.min(100, (1 - dI / dT) * 100))
        }
        prev = r
        last = { at: Date.now(), cpu, ramUsedGB: r.ramUsedGB }
        if (cpu !== null) {
            st.samples++
            st.cpuSum += cpu
            if (cpu > st.cpuPeak) {
                st.cpuPeak = cpu
            }
            if (cpuMax !== null && cpu > cpuMax) {
                st.overCpu++
            }
        }
        if (r.ramUsedGB > st.ramPeakGB) {
            st.ramPeakGB = r.ramUsedGB
        }
        if (ramMax !== null && r.ramUsedGB > ramMax) {
            st.overRam++
        }
        //逐分鐘之摘要(供事後看高點落在哪個階段; 至多保留 720 分鐘)
        let key = new Date(last.at).toISOString().slice(0, 16)
        let b = series.length && series[series.length - 1].t === key ? series[series.length - 1] : null
        if (!b) {
            b = { t: key, n: 0, cpuSum: 0, cpuMax: 0, ramMaxGB: 0 }
            series.push(b)
            if (series.length > 720) {
                series.shift()
            }
        }
        if (cpu !== null) {
            b.n++
            b.cpuSum += cpu
            if (cpu > b.cpuMax) {
                b.cpuMax = cpu
            }
        }
        if (r.ramUsedGB > b.ramMaxGB) {
            b.ramMaxGB = r.ramUsedGB
        }
        if (trace) {
            trace('sample', { cpu, ramUsedGB: r.ramUsedGB })
        }
        return last
    }

    let start = () => {
        if (timer) {
            return
        }
        if (trace) {
            trace('start', { sampleSec })
        }
        sample()
        timer = setInterval(sample, sampleSec * 1000)
        if (typeof timer.unref === 'function') {
            timer.unref()
        }
    }

    let stop = () => {
        if (timer) {
            clearInterval(timer)
            timer = null
            if (trace) {
                trace('stop', {})
            }
        }
    }

    let within = (s) => (cpuStart === null || s.cpu === null || s.cpu <= cpuStart) && (ramStart === null || s.ramUsedGB <= ramStart)

    //wait, 資源閘: 起新工作前呼叫
    let wait = async (tag = '') => {
        if (cpuStart === null && ramStart === null) {
            if (trace) {
                trace('wait-pass', { tag, waitedSec: 0, forced: false, limited: false })
            }
            return { waitedSec: 0, forced: false }
        }
        let t0 = Date.now()
        //無背景取樣或取樣過舊 ⇒ 現取(CPU 需兩次取樣之差, 故先取一次再隔 1 秒取第二次)
        if (!last || last.cpu === null || Date.now() - last.at > sampleSec * 2000) {
            sample()
            await sleep(1000)
            sample()
        }
        let waited = false
        while (!within(last)) {
            if ((Date.now() - t0) / 1000 >= maxWaitSec) {
                st.forced++
                st.waits += waited ? 0 : 1
                st.waitedSec += (Date.now() - t0) / 1000
                log(`資源閘 ${tag}: 等待逾 ${maxWaitSec} 秒仍超過門檻(CPU ${last.cpu === null ? '—' : last.cpu.toFixed(0)}%、已用記憶體 ${last.ramUsedGB.toFixed(1)} GB), 放行`)
                if (trace) {
                    trace('wait-forced', { tag, waitedSec: Math.round((Date.now() - t0) / 1000), forced: true })
                }
                return { waitedSec: Math.round((Date.now() - t0) / 1000), forced: true }
            }
            if (!waited) {
                waited = true
                st.waits++
                log(`資源閘 ${tag}: CPU ${last.cpu === null ? '—' : last.cpu.toFixed(0)}%(門檻 ${cpuStart === null ? '—' : cpuStart})、已用記憶體 ${last.ramUsedGB.toFixed(1)} GB(門檻 ${ramStart === null ? '—' : ramStart}), 等待`)
                if (trace) {
                    trace('wait-block', { tag, cpu: last.cpu, ramUsedGB: last.ramUsedGB })
                }
            }
            let sleepMs = pollSec * 1000 * (jitter > 0 ? 1 + jitter * (rand() - 0.5) : 1)
            if (trace) {
                trace('wait-poll', { tag, cpu: last.cpu, ramUsedGB: last.ramUsedGB, sleepMs })
            }
            await sleep(sleepMs)
            if (!timer) {
                sample()
            }
        }
        let sec = (Date.now() - t0) / 1000
        if (waited) {
            st.waitedSec += sec
        }
        if (trace) {
            trace('wait-pass', { tag, waitedSec: Math.round(sec), forced: false, limited: true })
        }
        return { waitedSec: Math.round(sec), forced: false }
    }

    let r1 = (x) => Math.round(x * 10) / 10
    let stats = () => ({
        samples: st.samples,
        cpuMean: st.samples ? r1(st.cpuSum / st.samples) : null,
        cpuPeak: st.samples ? r1(st.cpuPeak) : null,
        ramPeakGB: r1(st.ramPeakGB),
        overCpu: st.overCpu,
        overRam: st.overRam,
        waits: st.waits,
        waitedSec: Math.round(st.waitedSec),
        forced: st.forced,
        limits: { cpuMax, ramUsedMaxGB: ramMax, cpuStart, ramStartGB: ramStart },
        series: series.map((b) => ({ t: b.t, cpuMean: b.n ? r1(b.cpuSum / b.n) : null, cpuMax: b.n ? r1(b.cpuMax) : null, ramMaxGB: r1(b.ramMaxGB) })),
    })

    //reset, 統計歸零(每輪各記一份時用)
    let reset = () => {
        st = { samples: 0, cpuSum: 0, cpuPeak: 0, ramPeakGB: 0, overCpu: 0, overRam: 0, waits: 0, waitedSec: 0, forced: 0 }
        series = []
    }

    return { start, stop, sample, wait, stats, reset }
}


export { createResourceMonitor, osRead }
export default createResourceMonitor
