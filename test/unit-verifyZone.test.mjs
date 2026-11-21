import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { scanTrace, forbiddenPats } from '../src/domain/verify.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//節點之禁區涵蓋迴圈驗證之全部原始碼(規則 R-BT-10): src/domain/verify*、src/domain/backtest* —— 判定與門檻(含操作掃描之判法、兩條機械提示之判定)不被節點讀到而刻意規避
//  規格: ①節點之操作紀錄(指令或路徑)提到 src/domain/ 下檔名以 verify 或 backtest 起首者 ⇒ 列「觸及禁區: 回測期重放 / 迴圈驗證之程式」(套件裝在 node_modules/<套件名>/ 下者亦然)
//    ②節點任務書「不得讀取迴圈驗證之原始碼」一句所列之檔名樣式(backtest*.mjs、verify*.mjs)與禁區字樣同一組 ⇒ 該句所列之樣式涵蓋之檔皆被列(任務書與禁區不得各說各的)
//    ③指令解析(操作掃描之判法)、兩條機械提示之判定各在以 verify 起首之獨立檔(verifyCmdScan.mjs、verifyEvalHints.mjs); 不以非 verify 起首之檔名(例: 改名前之 cmdScan.mjs)置放判定 —— 該名不在禁區字樣內
let LABEL = '回測期重放 / 迴圈驗證之程式'
let cl = (input, name = 'Bash') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

describe('節點之禁區涵蓋迴圈驗證之全部原始碼(規則 R-BT-10)', function () {
    this.timeout(60000)
    let t
    let privateRoot = path.resolve(FD_ROOT, '..', 'proj-private')
    beforeEach(() => {
        t = makeTmp('verifyZone')
    })
    afterEach(() => {
        t.cleanup()
    })
    //nodeIssues, 節點(nodeRules)以一列工具呼叫掃一次, 回「觸及禁區」之項
    let nodeIssues = (input, name = 'Bash') => {
        let fp = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fp, cl(input, name))
        return scanTrace({ workDir: t.dir, logFile: fp, privateRoot, nodeRules: true, fileHits: 'note' }).issues
    }
    let hit = (issues) => issues.some((x) => x.includes(LABEL))
    let domainFiles = (re) => fs.readdirSync(path.join(FD_ROOT, 'src', 'domain')).filter((f) => re.test(f)).sort()

    it('① src/domain/ 下檔名以 verify 或 backtest 起首之每個檔:讀取(路徑與指令)皆列觸及禁區;套件裝於 node_modules 者亦然', () => {
        let vs = domainFiles(/^verify.*\.mjs$/)
        //已知之三個: 驗證本體、操作掃描之指令解析、兩條機械提示之判定
        for (let f of ['verify.mjs', 'verifyCmdScan.mjs', 'verifyEvalHints.mjs']) {
            assert(vs.includes(f), `src/domain/${f} 存在`)
        }
        let bs = domainFiles(/^backtest.*\.mjs$/)
        assert(bs.length >= 1, 'backtest* 至少一個')
        for (let f of [...vs, ...bs]) {
            assert(hit(nodeIssues({ file_path: `${FD_ROOT.replace(/\\/g, '/')}/src/domain/${f}` }, 'Read')), `Read 絕對路徑 ${f}`)
            assert(hit(nodeIssues({ filePath: `src/domain/${f}` }, 'Read')), `Read 相對路徑 ${f}`)
            assert(hit(nodeIssues({ command: `cat ./src/domain/${f}` })), `cat ${f}`)
            assert(hit(nodeIssues({ command: `head -n 40 node_modules/w-trade-adaptivess/src/domain/${f}` })), `套件裝於 node_modules: ${f}`)
        }
        assert(hit(nodeIssues({ command: 'cat src/domain/verifyCmdScan.mjs | head' })))
        //規格 ①: 其他檔不因此被列(禁區字樣之邊界): 任務書與 texts 等不以 verify / backtest 起首者, 以及他夾之同名檔
        assert.equal(hit(nodeIssues({ command: 'cat src/domain/texts.mjs' })), false)
        assert.equal(hit(nodeIssues({ command: 'cat src/eval/score.mjs' })), false)
    })

    it('② 任務書「不得讀取迴圈驗證之原始碼」一句所列之檔名樣式與禁區字樣同一組:其所列之樣式涵蓋之檔皆被列;不列 verify.mjs 單檔之寫法', () => {
        let st0 = getSettings()
        let st = { ...st0, rsi: { ...st0.rsi, guides: false } }
        let texts = makeTexts({ st, FD_ROOT: st.FD_ROOT })
        let task = { goal: 'g', type: 'explore', claim: null, arms: [{ id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }], base: null, refs: [], direction: null, toolbox: null }
        let s = texts.nodeBrief({ workDir: path.join(st.records.workDir, 'nodeX'), task, round: 7, nodeId: 'nodeX', attempt: 1 })
        let line = s.split('\n').find((l) => l.includes('讀取迴圈驗證之原始碼'))
        assert(line, '任務書有該句')
        //該句所列之檔名(去掉程式夾之路徑): 回測期工具 g_backtest.mjs 與兩組樣式; 不另列禁區字樣未涵蓋之檔(例: 單檔之 cmdScan.mjs)
        let clause = line.slice(line.indexOf('讀取迴圈驗證之原始碼'), line.indexOf(' —— '))
        let listed = [...clause.matchAll(/`([^`]+\.mjs)`/g)].map((m) => m[1].split('/').pop())
        assert.deepEqual(listed, ['g_backtest.mjs', 'backtest*.mjs', 'verify*.mjs'], line)
        //該句內之「…/<前綴>*.mjs」樣式
        let pats = [...line.matchAll(/`[^`]*\/([a-z]+)\*\.mjs`/g)].map((m) => m[1])
        assert.deepEqual(pats, ['backtest', 'verify'], line)
        assert(!/\/verify\.mjs`/.test(line), '不以單檔 verify.mjs 之寫法')
        for (let p of pats) {
            let fs0 = domainFiles(new RegExp(`^${p}.*\\.mjs$`))
            assert(fs0.length >= 1, `${p}*.mjs 有檔`)
            for (let f of fs0) {
                assert(hit(nodeIssues({ command: `cat src/domain/${f}` })), `任務書所列之樣式 ${p}*.mjs 涵蓋之 ${f} 被列`)
            }
        }
        //禁區字樣本身(節點規則)含此兩個前綴
        let pat = forbiddenPats(privateRoot, true).find(([re, label]) => label === LABEL)
        assert(pat && pat[0].test('src/domain/verifyEvalHints.mjs') && pat[0].test('lib/domain/backtestGrade.mjs'))
    })

    it('③ 判定不置於非 verify 起首之檔:改名前之 cmdScan.mjs 不在禁區字樣內(節點讀之不被列)—— 故指令解析改名為 verifyCmdScan.mjs;src/domain 下無 cmdScan.mjs', () => {
        //規格 ③: 禁區字樣只涵蓋 verify* 與 backtest* 起首者, 非此起首之檔(含改名前之 cmdScan.mjs)讀之不被列 ⇒ 判定不得放在其中
        assert.equal(fs.existsSync(path.join(FD_ROOT, 'src', 'domain', 'cmdScan.mjs')), false, '已改名')
        assert.equal(hit(nodeIssues({ command: 'cat src/domain/cmdScan.mjs' })), false, '改名前之檔名不在禁區字樣內(邊界)')
        assert.equal(hit(nodeIssues({ command: 'cat src/domain/verifyCmdScan.mjs' })), true)
        //判定所在之檔: 操作掃描之指令解析、兩條機械提示之判定(檔名皆以 verify 起首)
        let read = (f) => fs.readFileSync(path.join(FD_ROOT, 'src', 'domain', f), 'utf8')
        assert(/^let stripSearchPatterns = /m.test(read('verifyCmdScan.mjs')))
        assert(/^let peakHintOf = /m.test(read('verifyEvalHints.mjs')) && /^let twinHintOf = /m.test(read('verifyEvalHints.mjs')))
        assert(/^let EVAL_HINT = Object\.freeze/m.test(read('verifyEvalHints.mjs')), '門檻之常數在判定之檔內')
    })
})
