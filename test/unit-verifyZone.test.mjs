import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getSettings } from '../src/cfg.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { scanTrace, forbiddenPats, contentHits } from '../src/domain/verify.mjs'
import * as cmdScan from '../src/domain/verifyCmdScan.mjs'
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

    //成員依賴之判定(規則 R-REC-51; 比照 ⑤): 判定之組合與門檻在 src/domain/verifyMember.mjs(檔名以 verify 起首 ⇒ 節點之禁區涵蓋)
    //  規格: ①節點讀取或匯入 verifyMember.mjs(路徑與指令;套件裝於 node_modules 者亦然;內嵌腳本之匯入;共用工具區之逐檔檢查)皆列「觸及禁區: 回測期重放 / 迴圈驗證之程式」(同一條禁區字樣、同一標籤)
    //    ②判定與其門檻之預設只在該檔內(領域、附算之計畫、共同儲存區、命令列只讀設定、呼叫其函數, 不內嵌門檻之名)
    //    ③邊界: 附算之計畫與寫入(fillPlan.mjs; 讀數之列、補算檔、共同儲存區之欄, 無門檻)不在禁區內(節點得讀)
    it('⑥ 成員依賴之判定(verifyMember.mjs):節點讀取或匯入之(路徑與指令、node_modules、內嵌匯入、逐檔檢查)皆列;判定與門檻只在該檔;附算之計畫之檔不列', () => {
        let FD = FD_ROOT.replace(/\\/g, '/')
        let f = 'src/domain/verifyMember.mjs'
        //①讀取與匯入
        assert(hit(nodeIssues({ file_path: `${FD}/${f}` }, 'Read')), 'Read 絕對路徑')
        assert(hit(nodeIssues({ filePath: f }, 'Read')), 'Read 相對路徑')
        assert(hit(nodeIssues({ command: `cat ./${f}` })), 'cat')
        assert(hit(nodeIssues({ command: `head -n 40 node_modules/w-trade-adaptivess/${f}` })), '套件裝於 node_modules')
        assert(hit(nodeIssues({ command: `node -e "import('./node_modules/w-trade-adaptivess/${f}').then((m) => console.log(Object.keys(m)))"` })), '內嵌腳本匯入')
        assert(contentHits('import { memberHintOf } from \'../../node_modules/w-trade-adaptivess/src/domain/verifyMember.mjs\'\nexport default () => memberHintOf', privateRoot).includes(LABEL))
        assert(domainFiles(/^verify.*\.mjs$/).includes('verifyMember.mjs'), '檔名以 verify 起首(禁區字樣涵蓋)')
        //②判定與門檻只在該檔
        let read = (p) => fs.readFileSync(path.join(FD_ROOT, p), 'utf8')
        assert(/^let memberHintOf = /m.test(read(f)) && /^let MEMBER_DEFAULT = Object\.freeze/m.test(read(f)), '判定與門檻之預設在判定之檔內')
        for (let p of ['src/domain/domain.mjs', 'src/domain/fillPlan.mjs', 'src/domain/pickStore.mjs', 'src/cli/rsi.mjs', 'src/domain/texts.mjs']) {
            assert(!/minRetention|maxNegHalves/.test(read(p)), `${p} 不內嵌判定之門檻之名`)
        }
        //③邊界: 附算之計畫之檔(無門檻)不列
        for (let c of ['cat src/domain/fillPlan.mjs', 'cat src/domain/pickStore.mjs']) {
            assert.equal(hit(nodeIssues({ command: c })), false, `不列: ${c}`)
        }
        assert.equal(forbiddenPats(privateRoot, true).filter(([, label]) => label === LABEL).length, 1)
    })

    //禁區字樣之既有缺口(規則 R-BT-10 ⑦; 排程第 580 項 ①): 禁區字樣為路徑字樣(src/domain/verify… 連續出現); 下列三類寫法讀得到禁區之程式而不含該連續字樣
    //  ①萬用字元之前綴(src/domain/ver*、{verify,backtest}*、[vb]*、src/dom*/verify.mjs、src/tools/lib*)⇒ 依禁區之程式檔之清單(ZONE_FILES)展開, 有任一檔相符即列(同一個標籤)
    //  ②先切換目錄再以相對路徑(cd src && cat domain/verify.mjs、cd src/tools; cat libCheck.mjs、pushd、Set-Location、此前之工具呼叫切換者、帶 workdir 之欄者)⇒ 相對路徑依切換後之目錄解析成相對專案根之路徑後同一組禁區字樣判
    //  ③套件裝於 node_modules/<套件>/ 下之建置產物與文件(dist、docs、sgud、test、README: 內含判定之程式與門檻之值)⇒ 列同一個標籤(契約、範例、臂目錄、package.json 與 src/eval 不列)
    //  邊界: 非禁區之檔之前綴(src/domain/te*、src/tools/q*)、專案自己之 docs/、他套件之 dist、目錄不確定(含變數)之相對路徑不列
    //  nodeIssuesAt, 節點以多列工具呼叫依序掃一次(供此前之呼叫切換目錄者): inputs = [{ input, name? }]
    let nodeIssuesAt = (inputs) => {
        let fp = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fp, inputs.map((x) => cl(x.input, x.name || 'Bash')).join('\n'))
        return scanTrace({ workDir: t.dir, logFile: fp, privateRoot, nodeRules: true, fileHits: 'note' }).issues
    }

    it('⑦a 萬用字元之前綴:src/domain/ver*、{verify,backtest}*、[vb]*、?、src/dom*/verify.mjs、src/*/verify.mjs、src/tools/lib*、node_modules 下之各形、反斜線與 Glob / Grep 類工具之路徑欄接樣式欄 ⇒ 列;非禁區之檔之前綴不列', () => {
        let hits = [
            'cat src/domain/ver*', 'cat src/domain/verify*.mjs', 'head -n 5 src/domain/v*', 'cat src/domain/b*', 'cat src/domain/{verify,backtest}*.mjs', 'cat src/domain/{verify,texts}.mjs',
            'cat src/domain/[vb]*', 'cat src/domain/ver?fy.mjs', 'cat src/domain/*ify.mjs', 'cat src/domain/*Cmd*', 'cat src/domain/lib*', 'cat src/domain/libStat?.mjs', 'cat ./src/domain/ver*',
            'cat src/dom*/verify.mjs', 'cat s*/domain/verify.mjs', 'cat src/*/verify.mjs', 'cat src/*/ve*', 'cat sr?/domain/verifyMember.mjs', 'cat src/**/verify.mjs',
            'cat src/tools/lib*', 'cat src/tools/libC*', 'cat src/tools/*.mjs', 'cat src/tools/{libCheck,quota}.mjs', 'cat src/tool?/libCheck.mjs',
            'cat node_modules/w-trade-adaptivess/src/domain/ve*', 'cat node_modules/w-trade-adaptivess/src/dom*/v*', 'cat node_modules/*/src/domain/verify.mjs', 'cat node_modules/w-trade-adaptivess/src/tools/lib*',
            'cat node_modules/**/domain/verify.mjs', 'cat src/dom*', 'ls src/d*',
            //路徑段之正規化(./、..)與引號 / 跳脫字元之拼接(複審所見之未記繞過)
            'cat src/domain/./verify.mjs', 'cat src/domain/../domain/verify.mjs', 'cat ./src/./domain/verifyMember.mjs', 'cat src/dom""ain/verify.mjs', 'cat "src"/domain/verify.mjs', 'cat \'src/domain\'/verify.mjs', 'type src\\domain\\v^erify.mjs', 'gc src\\domain\\ver`ify.mjs', 'cat src/domain/ver""*',
            //套件之建置產物與文件之萬用字元(複審所見: 原只涵蓋 src)
            'cat node_modules/w-trade-adaptivess/d*/*', 'cat node_modules/w-trade-adaptivess/READ*', 'cat node_modules/w-trade-adaptivess/t*/*', 'cat node_modules/*/sgud/rule/*', 'cat node_modules/w-*/dist/*', 'cat dist/*.js', 'cat dist/w-trade-adaptivess*',
            'cat lib/domain/ver*', 'rg x src/domain/ver*', 'grep -n x src/domain/back*', 'type src\\domain\\ver*', 'node -e "require(\'fs\').readFileSync(\'src/domain/ver*\')"', 'cat "src/domain/ver*"',
        ]
        for (let c of hits) {
            assert(hit(nodeIssues({ command: c })), `列: ${c}`)
        }
        //絕對路徑(專案根給了才能展開): 以專案根之絕對路徑接萬用字元
        let fp = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fp, cl({ command: `cat ${FD_ROOT.replace(/\\/g, '/')}/src/domain/ver*` }))
        assert(hit(scanTrace({ workDir: t.dir, logFile: fp, privateRoot, nodeRules: true, fileHits: 'note', root: FD_ROOT }).issues), '絕對路徑 + 萬用字元(給專案根)')
        //Glob / Grep / Read 類之工具輸入: 樣式欄、路徑欄 × 樣式欄之接合
        for (let [input, name] of [[{ pattern: 'src/domain/ver*' }, 'Glob'], [{ pattern: 'domain/ver*', path: 'src' }, 'Glob'], [{ pattern: 'x', glob: 'src/domain/{verify,backtest}*.mjs' }, 'Grep'], [{ pattern: 'x', path: 'src', glob: 'domain/ver*.mjs' }, 'Grep'], [{ filePath: 'src/domain/ver*' }, 'Read'], [{ pattern: 'x', path: 'src/dom*', include: 'v*' }, 'Grep'],
            [{ pattern: 'dist/*' }, 'Glob'], [{ pattern: 'd*/*', path: 'node_modules/w-trade-adaptivess' }, 'Glob'], [{ pattern: 'x', path: 'node_modules', glob: 'w-trade-adaptivess/d*/**' }, 'Grep'],
            [{ pattern: '*', path: 'src/domain/../domain' }, 'Glob'], [{ filePath: 'src/domain/../domain/verify.mjs' }, 'Read'], [{ pattern: 'x', path: 'src/domain/..', glob: 'domain/v*' }, 'Grep']]) {
            assert(hit(nodeIssues(input, name)), `列: ${name} ${JSON.stringify(input)}`)
        }
        //有路徑欄者樣式欄只以接合後之整串判; Grep 類之 pattern 是內容之正規式(不當路徑): 節點在自己之工作夾 / 契約 / 範例夾列 .mjs 之常見之合法用法不誤列(複審所見之新增誤報)
        for (let [input, name] of [[{ pattern: '**/*.mjs', path: 'rsi/work/06c4e5f4bdd6d5f0' }, 'Glob'], [{ pattern: '**/*.mjs', path: 'examples' }, 'Glob'], [{ pattern: 'x', path: 'src/eval', glob: '**/*.mjs' }, 'Grep'], [{ pattern: 'src/domain/ver*', path: 'rsi/records' }, 'Grep'], [{ pattern: 'src/domain/ver*' }, 'Grep'], [{ pattern: 'src/domain/ver*' }, 'Search'], [{ pattern: '**/ver*', path: 'rsi/work/06c4e5f4bdd6d5f0' }, 'Glob'], [{ pattern: '*.mjs', path: 'rsi/work/06c4e5f4bdd6d5f0' }, 'Glob']]) {
            assert.equal(hit(nodeIssues(input, name)), false, `不列: ${name} ${JSON.stringify(input)}`)
        }
        //病態之輸入(複審所見: 連續之 * 使相鄰之 .* 指數回溯; 單一無空白字逾約 32K 字使正規式比對拋錯 ⇒ 整個掃描拋出): 不拋出、於 1 秒內判完; 過長或萬用字元過多之字無正當用途 ⇒ 列
        for (let c of [`cat ${'*'.repeat(16)}b`, `cat ${'*'.repeat(40)}b`, `cat src/${'a'.repeat(40000)}?`, `cat ${'{'.repeat(2000)}`, `cat ${'['.repeat(2000)}`, `cat ${'*a'.repeat(20)}`, `cat ${'?'.repeat(5000)}`]) {
            let t0 = Date.now()
            let r
            assert.doesNotThrow(() => {
                r = hit(nodeIssues({ command: c }))
            }, c.slice(0, 40))
            assert(Date.now() - t0 < 1000, `${c.slice(0, 30)}…: ${Date.now() - t0} ms`)
            assert.equal(typeof r, 'boolean')
        }
        assert(hit(nodeIssues({ command: `cat src/${'a'.repeat(40000)}?` })), '過長之字列(無正當用途)')
        assert(hit(nodeIssues({ command: `cat ${'*a'.repeat(20)}` })), '萬用字元過多之字列')
        let t1 = Date.now()
        nodeIssues({ command: `cd ..${' && cd ..'.repeat(1600)}` })
        assert(Date.now() - t1 < 1000, `1600 段 cd .. 於 1 秒內判完(逾專案根者改為不確定): ${Date.now() - t1} ms`)
        //邊界: 非禁區之檔之前綴與他夾
        for (let c of ['cat src/domain/te*', 'cat src/domain/t*.mjs', 'cat src/domain/{texts,domain}.mjs', 'cat src/domain/[dt]*.mjs', 'cat src/eval/*.mjs', 'cat src/eval/v*', 'cat src/tools/q*', 'cat src/tools/a*.mjs', 'cat src/tools/{quota,pickStore}.mjs', 'cat src/*.mjs', 'cat docs/ver*', 'ls ver*', 'find . -name "ver*"', 'cat node_modules/wsemi/src/domain/ve*', 'cat src?domain/verify.mjs', 'cat src/domain?verify.mjs']) {
            assert.equal(hit(nodeIssues({ command: c })), false, `不列: ${c}`)
        }
        //做夢(非節點規則)可讀迴圈驗證之程式、套件之文件: 本補充只涵蓋節點 ⇒ 做夢之操作掃描不列此標籤
        let dreamIssues = (input, name = 'Bash') => {
            let fp = path.join(t.dir, 'agent.log')
            fs.writeFileSync(fp, cl(input, name))
            return scanTrace({ workDir: t.dir, logFile: fp, privateRoot, fileHits: 'note' }).issues
        }
        for (let c of ['cat src/domain/ver*', 'cd src && cat domain/verify.mjs', 'cat node_modules/w-trade-adaptivess/README.md', 'cat node_modules/w-trade-adaptivess/dist/w-trade-adaptivess.umd.js']) {
            assert.equal(hit(dreamIssues({ command: c })), false, `做夢不列: ${c}`)
        }
        assert.equal(hit(dreamIssues({ pattern: 'src/domain/ver*' }, 'Glob')), false, '做夢不列: Glob')
        for (let [input, name] of [[{ pattern: 'src/eval/ve*' }, 'Glob'], [{ pattern: 'ver*.mjs', path: 'rsi/toolbox' }, 'Glob'], [{ pattern: 'verify.*', path: 'rsi/toolbox' }, 'Grep'], [{ pattern: 'x', glob: 'te*.mjs' }, 'Grep']]) {
            assert.equal(hit(nodeIssues(input, name)), false, `不列: ${name} ${JSON.stringify(input)}`)
        }
        //鑑別前提: 清單與實際檔案一致(盤點; 新增以 verify / backtest 起首之檔而未補清單者在此紅)
        let actual = [...domainFiles(/^(backtest|verify|libStats).*\.mjs$/).map((f) => `domain/${f}`), 'tools/libCheck.mjs'].sort()
        assert.deepEqual(cmdScan.ZONE_FILES.slice().sort(), actual, 'ZONE_FILES = src/domain 下以 backtest / verify 起首者與 libStats.mjs + src/tools/libCheck.mjs')
        for (let f of cmdScan.ZONE_FILES) {
            assert(fs.existsSync(path.join(FD_ROOT, 'src', f)), `src/${f} 存在`)
            let nm = path.basename(f)
            assert(hit(nodeIssues({ command: `cat src/${path.dirname(f)}/${nm.slice(0, 4)}*` })), `各檔皆可由其前綴之萬用字元涵蓋: ${f}`)
        }
    })

    it('⑦b 先切換目錄再以相對路徑:cd / pushd / Set-Location(同一道指令內、此前之工具呼叫、帶 workdir 之欄)⇒ 相對路徑依切換後之目錄解析;目錄不確定者與非禁區之檔不列', () => {
        let hits = [
            'cd src && cat domain/verify.mjs', 'cd src; cat domain/verify.mjs', 'cd src/ && head -n 3 domain/backtest.mjs', 'cd src && grep -n x domain/backtestGrade.mjs', 'cd src && cat domain/verifyCmdScan.mjs | head',
            'cd src/tools && cat libCheck.mjs', 'cd src && cd tools && cat libCheck.mjs', 'cd src && cat ./tools/libCheck.mjs', 'cd src/tools; node libCheck.mjs', 'cd "src" && cat "domain/verify.mjs"',
            'cd src\\tools && type libCheck.mjs', 'cd /d src && type domain\\verify.mjs', 'pushd src && cat domain/verify.mjs', 'pushd src\\tools & type libCheck.mjs', 'Set-Location src; Get-Content domain\\verify.mjs',
            'Set-Location -Path src; Get-Content domain\\verify.mjs', 'sl src; gc domain/verifyMember.mjs', 'chdir src && cat domain/verifyExposure.mjs', '(cd src && cat domain/verify.mjs)',
            'cd src && cat domain/ver*', 'cd src/domain/.. && cat domain/verify.mjs', 'cd src && cd domain/../tools && cat libCheck.mjs', 'cd src && cat tools/../domain/verify.mjs',
            'cd src && node -e "require(\'fs\').readFileSync(\'domain/verify.mjs\')"', 'cd src && node -e "import(\'./domain/verifyMember.mjs\')"',
            //殼層之內嵌指令(引號內)、cd 之前綴與控制結構(複審所見之未記繞過)
            'bash -c "cd src && cat domain/verify.mjs"', 'sh -c \'cd src; cat domain/verify.mjs\'', 'cmd /c "cd src && type domain\\verify.mjs"', 'powershell -Command "Set-Location src; Get-Content domain\\verify.mjs"',
            'if true; then cd src; fi; cat domain/verify.mjs', 'for f in a; do cd src; cat domain/verify.mjs; done', 'command cd src && cat domain/verify.mjs', 'builtin cd src && cat domain/verify.mjs', 'eval "cd src"; cat domain/verify.mjs',
            //切換後之目錄本身落在禁區夾(拆成兩段 cd 者; 字面 cd src/domain 原已由目錄級之規則列): 其後即使不帶路徑字(rg、ls | xargs cat)亦列
            'cd src && cd domain && rg threshold', 'cd src; cd domain; cat $(ls)', 'cd src && cd domain && ls | xargs cat', 'cd node_modules/w-trade-adaptivess && cd sgud && rg x', 'cd node_modules && cd w-trade-adaptivess && cd src && cd domain && rg x',
            //pushd 之堆疊: popd 回到原目錄(此處為專案根)之後再 cd 之目錄依回到之目錄解析
            'pushd src && popd && cd src && cat domain/verify.mjs', 'pushd a && pushd src && popd && popd && cd src && cat domain/verify.mjs',
            //popd 回到「已切換之非根目錄」(只有它辨得出 pushd 有入堆疊、popd 有取回; 回到專案根者與不確定者結果相同)
            'cd src && pushd tools && popd && cat domain/verify.mjs', 'cd src/tools && pushd ../.. && popd && cat libCheck.mjs', 'Set-Location src; Push-Location tools; Pop-Location; Get-Content domain\\verify.mjs',
            //套件裝於 node_modules 者之相對路徑
            'cd node_modules/w-trade-adaptivess && cat dist/w-trade-adaptivess.umd.js', 'cd node_modules/w-trade-adaptivess && cat README.md', 'cd node_modules/w-trade-adaptivess/sgud && cat rule/rulebook.md',
            'cd node_modules && cat w-trade-adaptivess/src/domain/verify.mjs',
        ]
        for (let c of hits) {
            assert(hit(nodeIssues({ command: c })), `列: ${c}`)
        }
        //此前之工具呼叫切換者(工作目錄跨呼叫沿用)
        assert(hit(nodeIssuesAt([{ input: { command: 'cd src' } }, { input: { command: 'cat domain/verify.mjs' } }])), '前一呼叫 cd src、其後 cat domain/verify.mjs')
        assert(hit(nodeIssuesAt([{ input: { command: 'cd src' } }, { input: { command: 'cd tools' } }, { input: { command: 'cat libCheck.mjs' } }])), '兩次切換')
        assert(hit(nodeIssuesAt([{ input: { command: 'cd src' } }, { input: { filePath: 'domain/verify.mjs' }, name: 'Read' }])), '切換後以 Read 讀相對路徑(非殼層之工具之路徑欄亦依工作目錄解析)')
        assert(hit(nodeIssuesAt([{ input: { command: 'cd src' } }, { input: { pattern: 'domain/ver*' }, name: 'Glob' }])), '切換後 Glob 之樣式')
        //切換目標含變數 / ~ / - 使目錄不確定之後, 其後之相對切換仍累積為相對鏈(複審所見: 原「毒化」使其後之 cd src 與讀取全不解析)
        assert(hit(nodeIssuesAt([{ input: { command: 'cd $HOME' } }, { input: { command: 'cd src && cat domain/verify.mjs' } }])), 'cd $HOME 之後 cd src && cat domain/verify.mjs')
        assert(hit(nodeIssuesAt([{ input: { command: 'cd ~' } }, { input: { command: 'cd src' } }, { input: { command: 'cat domain/verify.mjs' } }])), 'cd ~ 之後兩呼叫')
        assert(hit(nodeIssuesAt([{ input: { command: 'cd -' } }, { input: { command: 'cd src/tools && cat libCheck.mjs' } }])), 'cd - 之後')
        assert.equal(hit(nodeIssuesAt([{ input: { command: 'cd $HOME' } }, { input: { command: 'cat domain/verify.mjs' } }])), false, '基準不明且無相對鏈 ⇒ 只照原樣(不列)')
        //帶 workdir / cwd 之欄者以之為準(專案根之內 ⇒ 相對專案根; 專案根之外或不確定 ⇒ 不解析)
        let fp = path.join(t.dir, 'agent.log')
        let at = (input, root) => {
            fs.writeFileSync(fp, cl(input))
            return scanTrace({ workDir: t.dir, logFile: fp, privateRoot, nodeRules: true, fileHits: 'note', root }).issues
        }
        assert(hit(at({ command: 'cat domain/verify.mjs', workdir: 'src' }, FD_ROOT)), 'workdir = src')
        assert(hit(at({ command: 'cat verify.mjs', cwd: path.join(FD_ROOT, 'src', 'domain') }, FD_ROOT)), 'cwd = 絕對之 src/domain')
        assert.equal(hit(at({ command: 'cat domain/verify.mjs', workdir: 'rsi/work/n1' }, FD_ROOT)), false, 'workdir = 節點之工作夾 ⇒ 不列')
        //此前切換 + 另一呼叫帶 workdir: 帶者以其 workdir 為準、不受此前切換影響; 其後未帶 workdir 之呼叫仍沿用此前之切換(帶 workdir 之呼叫不改變持續之工作目錄)
        assert.equal(hit(nodeIssuesAt([{ input: { command: 'cd src' } }, { input: { command: 'cat domain/verify.mjs', workdir: 'rsi/work/n1' } }])), false, '帶 workdir 者以之為準')
        assert(hit(nodeIssuesAt([{ input: { command: 'cd src' } }, { input: { command: 'echo x', workdir: 'rsi/work/n1' } }, { input: { command: 'cat domain/verify.mjs' } }])), '帶 workdir 之呼叫不改變持續之工作目錄')
        //切回: 其後之相對路徑依切回後之目錄
        assert.equal(hit(nodeIssues({ command: 'cd src && cd .. && cat domain/verify.mjs' })), false, '切回專案根後 domain/verify.mjs 相對專案根 ⇒ 非 src/domain')
        assert.equal(hit(nodeIssues({ command: 'pushd src && popd && cat domain/verify.mjs' })), false, 'pushd / popd 回到原目錄')
        assert.equal(hit(nodeIssuesAt([{ input: { command: 'cd src' } }, { input: { command: 'cd ..' } }, { input: { command: 'cat domain/verify.mjs' } }])), false, '跨呼叫切回')
        //邊界: 非禁區之檔、目錄不確定(變數、~、-)、節點自己之工作夾內之正常操作
        for (let c of ['cd src && cat domain/texts.mjs', 'cd src && cat eval/score.mjs', 'cd src/tools && cat quota.mjs', 'cd rsi/work/nodeX && node ../../../g_eval.mjs --pick pick.mjs --mode quick', 'cd rsi/work/nodeX && cat pick.mjs', 'cd docs && cat pick-contract.md',
            'cd $D && cat domain/verify.mjs', 'cd ~ && cat domain/verify.mjs', 'cd - && cat domain/verify.mjs', 'cd "$SRC" && cat domain/verify.mjs', 'cd && cat domain/verify.mjs',
            //逾專案根(上層之同名夾不是本套件之 src): 不確定 ⇒ 不當成 src/domain 解析
            'cd ../src && cat domain/verify.mjs', 'cd ../../src && cat domain/verify.mjs']) {
            assert.equal(hit(nodeIssues({ command: c })), false, `不列: ${c}`)
        }
    })

    it('⑦c 套件之建置產物與文件(dist、docs、sgud、test、README):節點讀取裝於 node_modules/<套件>/ 下者(路徑、指令、Read、反斜線)皆列同一個標籤;契約、範例、臂目錄、src/eval、他套件之 dist 與專案自己之 docs 不列', () => {
        let hits = [
            'cat node_modules/w-trade-adaptivess/dist/w-trade-adaptivess.umd.js', 'cat node_modules/w-trade-adaptivess/dist/x.js', 'ls node_modules/w-trade-adaptivess/dist', 'head -c 2000 node_modules/w-trade-adaptivess/dist/w-trade-adaptivess.umd.js.map', 'grep -n minRetention node_modules/w-trade-adaptivess/README.md',
            'cat ./node_modules/w-trade-adaptivess/README.md', 'type node_modules\\w-trade-adaptivess\\README.md', 'ls node_modules/w-trade-adaptivess/docs', 'cat node_modules/w-trade-adaptivess/docs/domain_verifyEvalHints.mjs.html',
            'cat node_modules/w-trade-adaptivess/docs/dist/w-trade-adaptivess.umd.js', 'cat node_modules/w-trade-adaptivess/sgud/rule/rulebook_REC3.md', 'cat node_modules/w-trade-adaptivess/sgud/state/state.md',
            'cat node_modules/w-trade-adaptivess/test/unit-evalHints.test.mjs', 'rg -n EVAL_HINT node_modules/w-trade-adaptivess/test', 'cat dist/w-trade-adaptivess.umd.js', 'cat ./dist/w-trade-adaptivess.umd.js.map',
            'node -e "console.log(require(\'fs\').readFileSync(\'node_modules/w-trade-adaptivess/README.md\',\'utf8\'))"',
        ]
        for (let c of hits) {
            assert(hit(nodeIssues({ command: c })), `列: ${c}`)
        }
        for (let [input, name] of [[{ file_path: `${FD_ROOT.replace(/\\/g, '/')}/node_modules/w-trade-adaptivess/README.md` }, 'Read'], [{ filePath: 'node_modules/w-trade-adaptivess/dist/w-trade-adaptivess.umd.js' }, 'Read'], [{ pattern: 'x', path: 'node_modules/w-trade-adaptivess/sgud' }, 'Grep']]) {
            assert(hit(nodeIssues(input, name)), `列: ${name} ${JSON.stringify(input)}`)
        }
        //形成同一個標籤、同一條字樣(不另增標籤)
        assert.equal(forbiddenPats(privateRoot, true).filter(([, label]) => label === LABEL).length, 1)
        assert(forbiddenPats(privateRoot, true).find(([, label]) => label === LABEL)[0].test('node_modules/w-trade-adaptivess/README.md'))
        //共用工具區之逐檔檢查(contentHits)亦同一組字樣: 程式內容讀取套件之 README / dist 者列
        assert(contentHits('import fs from "fs"\nexport default () => fs.readFileSync("node_modules/w-trade-adaptivess/README.md", "utf8")', privateRoot).includes(LABEL))
        //不列: 套件之契約、範例、臂目錄、package.json、評估器之原始碼; 他套件之 dist 與 README; 專案自己之 docs / README
        for (let c of ['cat node_modules/w-trade-adaptivess/contract/pick-contract.md', 'cat node_modules/w-trade-adaptivess/examples/pick_example.mjs', 'cat node_modules/w-trade-adaptivess/arms/base.json', 'cat node_modules/w-trade-adaptivess/package.json',
            'cat node_modules/w-trade-adaptivess/src/eval/evalCore.mjs', 'cat node_modules/w-trade-adaptivess/settings.json', 'cat node_modules/wsemi/dist/wsemi.umd.js', 'cat node_modules/wsemi/README.md', 'cat docs/pick-contract.md', 'cat README.md', 'cat dist/other.js', 'cat examples/pick_example.mjs']) {
            assert.equal(hit(nodeIssues({ command: c })), false, `不列: ${c}`)
        }
        //README 之敘述與禁區一致: README 載有判定之門檻之值者(迴圈檢查之機械提示之條件)在套件裝於 node_modules 下時屬節點之禁區
        let readme = fs.readFileSync(path.join(FD_ROOT, 'README.md'), 'utf8')
        assert(readme.includes('門檻之值只在本文件、規則帳本、state 與 `verifyEvalHints.mjs` 之 `EVAL_HINT`') && readme.includes('套件裝於 `node_modules/w-trade-adaptivess/` 下者之 `README.md`、`dist/`、`docs/`、`sgud/`、`test/` 皆在節點之禁區字樣內'), 'README 說明門檻之值之記載處與其禁區')
    })
})
