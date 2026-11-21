import assert from 'assert'
import fs from 'fs'
import path from 'path'
import * as cmdScan from '../src/domain/verifyCmdScan.mjs'
import { stripSearchPatterns } from '../src/domain/verifyCmdScan.mjs'
import * as verify from '../src/domain/verify.mjs'
import { scanTrace, forbiddenPats, setGuardExtra } from '../src/domain/verify.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//操作掃描所用之指令解析模組(src/domain/verifyCmdScan.mjs; 規則 R-BT-6、R-BT-7 與做夢之搜尋樣式之去除; 檔名帶 verify 字首 ⇒ 節點之禁區字樣涵蓋之, 見 unit-verifyZone)之本模組自有之判定:
//  ① 搜尋樣式取自檔(grep 族與 rg 之 -f / --file、findstr 之 /G:)或無位置樣式(rg --files): 其後之第一個非選項引數是路徑, 不得當成樣式去掉 ⇒ 禁區之路徑照查
//  ② 迴圈專用之環境變數(ARSI_HARNESS 與 ARSI_AGENT_ROLE; 規則 R-RUN-11)同一條禁區字樣、同一個標籤
//  ③ 結構: 引號遮蔽只留一份; 解析函數只在本模組(verify.mjs 不再定義、不再匯出)
//  (搬移前後之判定不變, 以提交版對生成語料與全部測試語料之逐案比對為證, 見規則帳本 R-BT-7 之盤點; 既有之判定由 unit-guard、unit-guardInline、unit-scanListRoot、unit-scanEntryExec 之案守)
describe('指令解析模組 verifyCmdScan.mjs', function () {
    this.timeout(60000)
    let t
    let privateRoot = path.resolve(FD_ROOT, '..', 'proj-private')
    beforeEach(() => {
        t = makeTmp('cmdScan')
        setGuardExtra([]) //模組層狀態(專案另加之禁區字樣): 標籤清單之斷言須不受他檔殘留影響
    })
    afterEach(() => {
        t.cleanup()
    })
    //cl, claude 格式之一列工具呼叫; scan, 以一列或多列之紀錄掃一次(做夢 = 預設; 節點 = nodeRules)
    let cl = (input, name = 'Bash') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
    let scan = (inputs, opt = {}) => {
        let fp = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fp, inputs.map((x) => cl(x)).join('\n'))
        return scanTrace({ workDir: t.dir, logFile: fp, privateRoot, fileHits: 'note', ...opt })
    }

    it('① 搜尋樣式取自檔或無位置樣式 ⇒ 其後之第一個非選項引數是路徑, 不去掉(禁區之路徑照查; 檔名之字照留); 以 -e / 位置引數給樣式者照去', () => {
        //規格: stripSearchPatterns 只去「樣式」、被搜尋之路徑照查(做夢之禁區字樣比對); -f / --file(grep、rg)與 /G:(findstr)之樣式取自檔, 無位置樣式
        let kept = (c) => stripSearchPatterns(c).includes('g_backtest.mjs')
        let fileForms = [
            'grep -f pats.txt g_backtest.mjs',
            'grep --file pats.txt g_backtest.mjs',
            'grep --file=pats.txt g_backtest.mjs',
            'grep -rf pats.txt g_backtest.mjs',
            'grep -nf pats.txt g_backtest.mjs',
            'grep -Ef pats.txt g_backtest.mjs',
            'grep -fpats.txt g_backtest.mjs',
            'grep -r -f pats.txt -n g_backtest.mjs',
            'grep -f "pats file.txt" g_backtest.mjs',
            'egrep -f pats.txt g_backtest.mjs',
            'fgrep -f pats.txt g_backtest.mjs',
            '/usr/bin/grep -f pats.txt g_backtest.mjs',
            'git -C . grep -f pats.txt -- g_backtest.mjs',
            'rg -f pats.txt g_backtest.mjs',
            'rg --file pats.txt g_backtest.mjs',
            'rg --file=pats.txt g_backtest.mjs',
            'rg -nf pats.txt g_backtest.mjs',
            'rg --files g_backtest.mjs',
            'rg --files -g "*.mjs" g_backtest.mjs',
            'rg -n --files g_backtest.mjs',
            'bin\\rg.exe --files g_backtest.mjs',
            'findstr /G:pats.txt g_backtest.mjs',
            'findstr /S /I /G:pats.txt g_backtest.mjs',
            'findstr /g:pats.txt g_backtest.mjs',
            'grep.exe -f pats.txt g_backtest.mjs',
            //選項置於運算元之後(GNU 之選項排列): 該運算元仍是路徑
            'grep g_backtest.mjs -f pats.txt',
            'grep -n g_backtest.mjs -rf pats.txt',
            'grep g_backtest.mjs --file=pats.txt',
            'grep g_backtest.mjs --file pats.txt',
            'rg g_backtest.mjs -f pats.txt',
            'rg g_backtest.mjs --files',
            'rg -n g_backtest.mjs --files -g "*.mjs"',
            'findstr g_backtest.mjs /G:pats.txt',
            'findstr /S g_backtest.mjs /I /G:pats.txt',
        ]
        for (let c of fileForms) {
            assert(kept(c), `禁區之路徑須留: ${c} ⇒ ${stripSearchPatterns(c)}`)
        }
        //樣式檔本身之路徑照留(讀取禁區之檔當樣式檔也是存取)
        for (let c of ['grep -f ledger/train/p.txt x.mjs', 'grep --file ledger/train/p.txt x.mjs', 'rg -f ledger/train/p.txt x.mjs']) {
            assert(stripSearchPatterns(c).includes('ledger/train/p.txt'), `樣式檔之路徑須留: ${c}`)
        }
        //有樣式者照去(含同一指令另有 -f 者之 -e 樣式), 路徑照留
        let stripped = [
            'grep "g_backtest" lib/x.mjs',
            'grep -e "g_backtest" lib/x.mjs',
            'grep -e "g_backtest" -f pats.txt lib/x.mjs',
            'grep -A 3 -n "g_backtest" lib/x.mjs',
            'egrep "g_backtest|ARSI" lib/x.mjs',
            'rg -n "g_backtest" lib/x.mjs',
            'git -C . grep -n "g_backtest" -- lib',
            //以檔給樣式者之後另有 -e 給樣式(兩者並用): -f 之值(下一個字)須被跳過, 其後之 -e 仍須處理
            'grep -f pats.txt -e "g_backtest" lib/x.mjs',
            'grep -rf pats.txt -e "g_backtest" lib/x.mjs',
            'grep -fpats.txt -e "g_backtest" lib/x.mjs',
            'rg -f pats.txt -e "g_backtest" lib/x.mjs',
            'grep --file pats.txt -e "g_backtest" lib/x.mjs',
            //--files 為 rg 之選項(只列檔、無位置樣式); grep 無此選項 ⇒ 其後之第一個非選項引數仍是樣式
            'grep --files "g_backtest" lib/x.mjs',
            //運算元之後之選項不涉樣式檔者 / 「--」之後之 -f 是運算元(非選項)⇒ 前之運算元仍是樣式
            'grep "g_backtest" lib/x.mjs -n',
            'grep "g_backtest" lib/x.mjs -- -f',
            'rg "g_backtest" lib/x.mjs --files-with-matches',
            'findstr "g_backtest" x.mjs /I /S',
            'findstr /S /C:"g_backtest" *.mjs',
            'findstr "g_backtest" x.mjs',
        ]
        for (let c of stripped) {
            let r = stripSearchPatterns(c)
            assert(!r.includes('g_backtest'), `樣式須去: ${c} ⇒ ${r}`)
        }
        assert(stripSearchPatterns('grep -e "g_backtest" lib/g_backtest.mjs').includes('lib/g_backtest.mjs'))
        //rg 之 -r 帶值(--replace): -rf 之 f 是其值而非樣式檔 ⇒ 其後之 x 為樣式(去)、"g_backtest" 為路徑(留); grep 之 -r 不帶值 ⇒ -rf 之 f 為樣式檔(上列)
        assert.equal(stripSearchPatterns('rg -rf x "g_backtest" lib'), 'rg -rf   "g_backtest" lib')
        //ag / ack 之 -f 義異, 不在本判定內(照既有); 非搜尋指令不動
        assert.equal(stripSearchPatterns('cat -f x g_backtest.mjs'), 'cat -f x g_backtest.mjs')
        //⇒ 掃描: 做夢以 grep -f 搜尋禁區之路徑 ⇒ 列; 以禁區字樣為樣式者照不列(既有); 節點照列
        let ledgerArg = 'rsi/data/ledger/train/x.f32'
        for (let c of ['grep -f pats.txt data/ledger/train/x.f32', 'grep --file=pats.txt data/ledger/train/x.f32', 'rg --files data/ledger/eval', 'findstr /G:pats.txt data\\ledger\\full\\x.f32', 'grep data/ledger/train/x.f32 -f pats.txt', 'rg data/ledger/eval --files', 'findstr data\\ledger\\full\\x.f32 /G:pats.txt']) {
            let r = scan([{ command: c }])
            assert(r.issues.some((x) => x.includes('帳本檔')), `做夢: ${c} ⇒ ${JSON.stringify(r.issues)}`)
            assert(scan([{ command: c }], { nodeRules: true }).issues.some((x) => x.includes('帳本檔')), `節點: ${c}`)
        }
        assert(scan([{ command: `grep -f pats.txt ${ledgerArg}` }]).issues.some((x) => x.includes('帳本檔')))
        assert.deepEqual(scan([{ command: 'grep -rn "ledger/train" rsi/toolbox/' }]).issues, [], '以禁區字樣為樣式者照不列(既有)')
        assert.deepEqual(scan([{ command: 'grep -f pats.txt rsi/toolbox/x.mjs' }]).issues, [], '路徑非禁區 ⇒ 不列')
    })

    it('② 迴圈專用之環境變數 ARSI_HARNESS 與 ARSI_AGENT_ROLE 同一條禁區字樣、同一個標籤;工具輸入提到者(節點、做夢)皆列;搜尋樣式內者照做夢之既有不列;未提到者不列', () => {
        //規格(規則 R-RUN-11): 提到 ARSI_AGENT_ROLE 之工具輸入併入既有之禁區字樣「迴圈專用之環境變數」(同 ARSI_HARNESS; 標籤不變); 搜尋樣式內者照 stripSearchPatterns 不算存取
        let label = '迴圈專用之環境變數'
        for (let nodeRules of [false, true]) {
            let pats = forbiddenPats(privateRoot, nodeRules)
            let hit = (s) => pats.filter(([re]) => {
                re.lastIndex = 0
                return re.test(s)
            }).map(([, l]) => l)
            assert.deepEqual(hit('ARSI_HARNESS'), [label])
            assert.deepEqual(hit('ARSI_AGENT_ROLE'), [label])
            assert.deepEqual(hit('process.env.ARSI_AGENT_ROLE = ""'), [label])
            assert.deepEqual(hit('ARSI_AGENT'), [], '只提到前綴不列')
            assert.deepEqual(hit('ARSI_ROLE'), [])
            assert.deepEqual(pats.map(([, l]) => l), ['回測期工具 g_backtest', label, '私有根', '帳本檔', '專案之 data 夾', '舊制之備份', ...(nodeRules ? ['回測期重放 / 迴圈驗證之程式'] : [])], '標籤之清單與次序不變(不另增一條)')
        }
        let cmds = ['echo $ARSI_AGENT_ROLE', 'ARSI_AGENT_ROLE= node g_eval.mjs --pick x.mjs --mode quick', 'env -u ARSI_AGENT_ROLE ls', 'unset ARSI_AGENT_ROLE', 'set ARSI_AGENT_ROLE=', 'node -e "delete process.env.ARSI_AGENT_ROLE"', 'printenv ARSI_HARNESS']
        for (let c of cmds) {
            for (let nodeRules of [false, true]) {
                let r = scan([{ command: c }], { nodeRules })
                assert(r.issues.some((x) => x.startsWith(`觸及禁區: ${label}(指令或路徑): `)), `${nodeRules ? '節點' : '做夢'}: ${c} ⇒ ${JSON.stringify(r.issues)}`)
            }
        }
        //做夢: 以之為搜尋樣式 ⇒ 不是存取(同 ARSI_HARNESS); 節點照列; 路徑引數含之者照列
        assert.deepEqual(scan([{ command: 'grep -rn "ARSI_AGENT_ROLE" rsi/toolbox/' }]).issues, [])
        assert.deepEqual(scan([{ command: 'grep -rlE "g_eval|ARSI_AGENT_ROLE" rsi/toolbox/' }]).issues, [])
        assert(scan([{ command: 'grep -rn "ARSI_AGENT_ROLE" rsi/toolbox/' }], { nodeRules: true }).issues.some((x) => x.includes(label)))
        assert(scan([{ command: 'grep -rn foo rsi/toolbox/ARSI_AGENT_ROLE.txt' }]).issues.some((x) => x.includes(label)))
        assert(scan([{ command: 'grep -f ARSI_AGENT_ROLE.txt x.mjs' }]).issues.some((x) => x.includes(label)), '樣式檔之路徑含之者照列')
        //搜尋工具(Grep 之 pattern 欄)與一般指令: 做夢之搜尋樣式欄不算(既有), 其他欄照列
        let fpL = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fpL, cl({ pattern: 'ARSI_AGENT_ROLE', path: 'rsi/toolbox' }, 'Grep'))
        assert.deepEqual(scanTrace({ workDir: t.dir, logFile: fpL, privateRoot, fileHits: 'note' }).issues, [])
        fs.writeFileSync(fpL, cl({ pattern: 'x', path: 'rsi/ARSI_AGENT_ROLE' }, 'Grep'))
        assert(scanTrace({ workDir: t.dir, logFile: fpL, privateRoot, fileHits: 'note' }).issues.some((x) => x.includes(label)))
        //未提到者不列(任務書之範例與常用指令)
        for (let c of ['node g_eval.mjs --pick x.mjs --mode quick --out r.json', 'node g_toolbox.mjs', 'ls -la', 'grep -n foo a.txt']) {
            assert.deepEqual(scan([{ command: c }]).issues, [], c)
        }
        //寫入之程式檔(工作夾內)提到者 ⇒ 逐檔掃描照列(節點) / 做夢列待核對(fileNotes; 同禁區字樣之既有作法)
        fs.writeFileSync(path.join(t.dir, 'x.mjs'), 'delete process.env.ARSI_AGENT_ROLE\n')
        fs.writeFileSync(fpL, cl({ command: 'ls' }))
        assert(scanTrace({ workDir: t.dir, logFile: fpL, privateRoot, nodeRules: true }).issues.some((x) => x.includes(`${label}(檔 x.mjs)`)))
        assert.deepEqual(scanTrace({ workDir: t.dir, logFile: fpL, privateRoot, fileHits: 'note' }).fileNotes, [`${label}(檔 x.mjs)`])
    })

    it('③ 結構: 引號遮蔽只留一份(其餘皆經 maskQuotes / unmaskQuotes); 解析函數只在 verifyCmdScan.mjs(verify.mjs 不再定義、不再匯出); 匯出面固定; 常數不重複', () => {
        let src = fs.readFileSync(path.join(FD_ROOT, 'src', 'domain', 'verifyCmdScan.mjs'), 'utf8')
        let count = (s, re) => (s.match(re) || []).length
        //遮蔽之正規式與佔位符之產生各一處
        assert.equal(count(src, /\/"\(\?:\[\^"\\\\\]\|\\\\\.\)\*"\|'\[\^'\]\*'\/g/g), 1, '引號遮蔽之正規式只一份')
        assert.equal(count(src, /\\u0001\$\{quoted\.length - 1\}\\u0002/g), 1, '佔位符之產生只一處')
        assert.equal(count(src, /\.replace\(\/\\u0001/g), 0, '不另以字面之正規式還原佔位符')
        //共用常數只定義一次: 殼層、變數指派、包裝、前綴
        for (let name of ['SHELLS', 'EVAL_WRAPS', 'CMD_PREFIXES', 'SCRIPT_RUNNERS', 'VAR_ASSIGN', 'EX_SKIP', 'RL_SKIP', 'EX_WRAPS']) {
            assert.equal(count(src, new RegExp(`^let ${name} = `, 'gm')), 1, `${name} 只定義一次`)
        }
        assert.equal(count(src, /\[A-Za-z_\]\[A-Za-z0-9_\]\*=/g), 1, '變數指派之正規式只一份')
        assert.equal(count(src, /\bEX_SHELLS\b|\bRL_SHELLS\b|\bRL_WRAP\b/g), 0, '已合併之常數名不再出現')
        //匯出面
        assert.deepEqual(Object.keys(cmdScan).sort(), ['LR_CD', 'absOf', 'entryExecOf', 'listRootExempt', 'recursiveRootOf', 'scriptListsRoot', 'stripSearchPatterns', 'toolListsRoot'])
        for (let k of ['entryExecOf', 'recursiveRootOf', 'stripSearchPatterns', 'listRootExempt', 'toolListsRoot', 'scriptListsRoot']) {
            assert(!(k in verify), `verify.mjs 不再匯出 ${k}`)
        }
        let vsrc = fs.readFileSync(path.join(FD_ROOT, 'src', 'domain', 'verify.mjs'), 'utf8')
        for (let fn of ['stripSearchPatterns', 'listRootExempt', 'entryExecOf', 'recursiveRootOf', 'scriptListsRoot', 'toolListsRoot', 'exQuote', 'exSegs', 'exHeredoc', 'exArgs', 'rlCovers', 'absOf']) {
            assert.equal(count(vsrc, new RegExp(`^let ${fn} = `, 'gm')), 0, `verify.mjs 不再定義 ${fn}`)
        }
        //聚合入口不匯出解析函數
        let agg = fs.readFileSync(path.join(FD_ROOT, 'src', 'WTradeAdaptivess.mjs'), 'utf8')
        assert(!/cmdScan/i.test(agg), '聚合入口不加(檔名改為 verifyCmdScan 後仍須不分大小寫地擋)')
    })
})
