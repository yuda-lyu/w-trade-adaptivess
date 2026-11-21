import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { scanTrace, forbiddenPats, contentHits } from '../src/domain/verify.mjs'
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

    //庫況體檢之程式(規則 R-EV-48 之主控專用工具; 排程第 589 項之主控另加): 其輸出含評估期內全庫之統計(事後資訊), 節點不得執行亦不得讀取或匯入其程式
    //  規格: ①節點之操作紀錄(指令或路徑)提到 src/domain/libStats.mjs 或 src/tools/libCheck.mjs(含套件裝於 node_modules 者)⇒ 列「觸及禁區: 回測期重放 / 迴圈驗證之程式」(同一條禁區字樣)
    //    ②執行 tools/libCheck.mjs 照列 R-BT-7 ① 之「執行迴圈之寫檔入口」(節點與做夢皆查; 與各入口之拒跑同一張表)
    //    ③邊界: 其他 src/domain/ 檔與 src/eval/ 下之檔(含 R-EV-47 之 subsetRule.mjs; 內容只含訓練期與靜態欄之判定)不因此被列(節點得讀評估器之原始碼; 與既有之 R-BT-10 同); 做夢(非節點規則)不列「讀取」
    //  同一條禁區字樣、同一個標籤(unit-cmdScan 釘死「標籤之清單與次序不變」): 庫況體檢之程式併入既有之「回測期重放 / 迴圈驗證之程式」
    let LABEL2 = LABEL
    let EXEC = '執行迴圈之寫檔入口'
    let hit2 = (issues) => issues.some((x) => x.includes(LABEL2))
    it('④ 庫況體檢之程式:節點讀取或匯入 src/domain/libStats.mjs、src/tools/libCheck.mjs(路徑與指令;套件裝於 node_modules 者亦然)皆列;執行 tools/libCheck.mjs 照列「執行迴圈之寫檔入口」;其他檔不因此被列', () => {
        let FD = FD_ROOT.replace(/\\/g, '/')
        for (let f of ['src/domain/libStats.mjs', 'src/tools/libCheck.mjs']) {
            assert(hit2(nodeIssues({ file_path: `${FD}/${f}` }, 'Read')), `Read 絕對路徑 ${f}`)
            assert(hit2(nodeIssues({ filePath: f }, 'Read')), `Read 相對路徑 ${f}`)
            assert(hit2(nodeIssues({ command: `cat ./${f}` })), `cat ${f}`)
            assert(hit2(nodeIssues({ command: `head -n 40 node_modules/w-trade-adaptivess/${f}` })), `套件裝於 node_modules: ${f}`)
            assert(hit2(nodeIssues({ command: `node -e "import('./node_modules/w-trade-adaptivess/${f}').then((m) => console.log(Object.keys(m)))"` })), `內嵌腳本匯入 ${f}`)
        }
        //②執行(R-BT-7 ①; 既有之判定): 節點與做夢皆列, 且不另列 LABEL2(執行之指令不含 src/ 路徑時亦照列)
        for (let c of ['node tools/libCheck.mjs', 'node tools/libCheck.mjs --json --dir-hi 0.8', 'npx node tools/libCheck.mjs']) {
            assert(nodeIssues({ command: c }).some((x) => x.includes(EXEC)), `節點執行 ${c}`)
        }
        //③邊界: 不涵蓋之檔
        for (let c of ['cat src/domain/texts.mjs', 'cat src/eval/subsetRule.mjs', 'cat src/eval/ledger.mjs', 'cat src/domain/agentEntries.mjs', 'cat src/tools/briefPreview.mjs', 'node g_eval.mjs --pick p.mjs --mode quick --subset side:long']) {
            assert.equal(hit2(nodeIssues({ command: c })), false, `不列: ${c}`)
        }
        assert.equal(hit2(nodeIssues({ file_path: `${FD}/src/eval/subsetRule.mjs` }, 'Read')), false, 'Read src/eval/subsetRule.mjs 不列(同 src/eval/ 之既有檔)')
        //做夢非節點規則: 禁區字樣之清單(forbiddenPats(…, false))不含此項
        assert.equal(forbiddenPats(privateRoot, false).some(([, label]) => label === LABEL2), false)
        assert.equal(forbiddenPats(privateRoot, true).filter(([, label]) => label === LABEL2).length, 1, '標籤之條數不變(同一條字樣,不另增)')
    })

    it('④ 共用工具區之逐檔檢查(contentHits;節點規則):程式內容匯入 libStats.mjs 或 libCheck.mjs 者列庫況體檢之程式;不提者不列', () => {
        assert(contentHits('import { libReportOf } from \'../../node_modules/w-trade-adaptivess/src/domain/libStats.mjs\'\nexport default () => libReportOf', privateRoot).includes(LABEL2))
        assert(contentHits('let m = await import(\'./src/tools/libCheck.mjs\')', privateRoot).includes(LABEL2))
        assert.equal(contentHits('import { memberLedger } from \'../../src/eval/ledger.mjs\'\nexport default () => 1', privateRoot).includes(LABEL2), false)
    })

    //側別曝險之判定與放行之工具(規則 R-REC-48; 排程第 591 項之主控另加): 判定之組合與門檻在 src/domain/verifyExposure.mjs(檔名以 verify 起首 ⇒ 節點之禁區涵蓋)
    //  規格: ①節點讀取或匯入 verifyExposure.mjs(路徑與指令;套件裝於 node_modules 者亦然;內嵌腳本之匯入;共用工具區之逐檔檢查)皆列「觸及禁區: 回測期重放 / 迴圈驗證之程式」(同一條禁區字樣、同一標籤)
    //    ②判定與其門檻之預設只在該檔內(domain.mjs 與 tools/exposure.mjs 只讀設定、呼叫 exposureOf, 不內嵌判定之組合或門檻之名)
    //    ③執行 tools/exposure.mjs 帶引數(放行、撤銷)者照列「執行迴圈之寫檔入口」(節點與做夢皆查; 與入口之拒跑同一張表 —— 表內有 exposure); 不帶引數(列出)者與 tools/rankCompare.mjs(唯讀)不列
    //    ④邊界(依「判定、門檻不該讓節點讀到」之既有判準): 全樹之側別讀數(sideRead.mjs;只列讀數與警示、不改任何選取、S 或階梯,節點個別之成品無從藉其門檻規避)、
    //      量尺並列之估法(rankCompare.mjs 與 tools/rankCompare.mjs;純統計、無門檻、唯讀)、放行之工具本身(tools/exposure.mjs;只含放行之管道)不在禁區內 —— 與既有之 domain.mjs 內之看板與搜尋地圖之集中度指標同(節點得讀)
    it('⑤ 側別曝險之判定(verifyExposure.mjs):節點讀取或匯入之(路徑與指令、node_modules、內嵌匯入、逐檔檢查)皆列;判定與門檻只在該檔;執行放行之工具照列「執行迴圈之寫檔入口」;讀數與估法之檔、列出與唯讀之工具不列', () => {
        let FD = FD_ROOT.replace(/\\/g, '/')
        let f = 'src/domain/verifyExposure.mjs'
        //①讀取與匯入
        assert(hit(nodeIssues({ file_path: `${FD}/${f}` }, 'Read')), 'Read 絕對路徑')
        assert(hit(nodeIssues({ filePath: f }, 'Read')), 'Read 相對路徑')
        assert(hit(nodeIssues({ command: `cat ./${f}` })), 'cat')
        assert(hit(nodeIssues({ command: `head -n 40 node_modules/w-trade-adaptivess/${f}` })), '套件裝於 node_modules')
        assert(hit(nodeIssues({ command: `node -e "import('./node_modules/w-trade-adaptivess/${f}').then((m) => console.log(Object.keys(m)))"` })), '內嵌腳本匯入')
        assert(contentHits('import { exposureOf } from \'../../node_modules/w-trade-adaptivess/src/domain/verifyExposure.mjs\'\nexport default () => exposureOf', privateRoot).includes(LABEL))
        assert(domainFiles(/^verify.*\.mjs$/).includes('verifyExposure.mjs'), '檔名以 verify 起首(禁區字樣涵蓋)')
        //②判定與門檻只在該檔
        let read = (p) => fs.readFileSync(path.join(FD_ROOT, p), 'utf8')
        assert(/^let exposureOf = /m.test(read(f)) && /^let EXPOSURE_DEFAULT = Object\.freeze/m.test(read(f)), '判定與門檻之預設在判定之檔內')
        for (let p of ['src/domain/domain.mjs', 'src/tools/exposure.mjs', 'src/tools/rankCompare.mjs']) {
            assert(!/minShift|fixedState|placeboTiming/.test(read(p)), `${p} 不內嵌判定之門檻或旗標名`)
        }
        //③執行
        for (let c of ['node tools/exposure.mjs --node a1b2c3 --why x', 'node src/tools/exposure.mjs --undo --node a1b2c3 --why x', 'npx node tools/exposure.mjs --node a1b2c3 --why x']) {
            assert(nodeIssues({ command: c }).some((x) => x.includes(EXEC)), `節點執行 ${c}`)
        }
        for (let c of ['node tools/exposure.mjs', 'node src/tools/rankCompare.mjs', 'node tools/rankCompare.mjs --k 5']) {
            assert.equal(nodeIssues({ command: c }).some((x) => x.includes(EXEC)), false, `不列(唯讀): ${c}`)
        }
        //④邊界: 不涵蓋之檔(讀取不列)
        for (let c of ['cat src/domain/sideRead.mjs', 'cat src/domain/rankCompare.mjs', 'cat src/tools/rankCompare.mjs', 'cat src/tools/exposure.mjs', 'cat src/domain/domain.mjs']) {
            assert.equal(hit(nodeIssues({ command: c })), false, `不列: ${c}`)
        }
        //禁區字樣之標籤條數不變(同一條字樣)
        assert.equal(forbiddenPats(privateRoot, true).filter(([, label]) => label === LABEL).length, 1)
    })
})
