import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { stripSearchPatterns } from '../src/domain/cmdScan.mjs'
import { scanTrace, stripInlinePatterns, forbiddenPats, setGuardExtra } from '../src/domain/verify.mjs'
import { getSettings } from '../src/cfg.mjs'
import { makeProject } from '../src/domain/domain.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'


//操作稽核: 做夢之內嵌腳本(node -e)內「比對內容用」之字樣不是存取; 實際之存取(讀檔、起子行程、殼層之路徑)照列
//  只去: 正規式字面值、比對函數之字串引數、腳本內之註解; 其他字串一律照查
//  被去掉之片段內含禁區字樣者列為待核對(inlineNotes; 不計為觸及禁區)
//  不變式: 原指令(只去搜尋樣式)命中之每個禁區字樣, 必在「觸及禁區」或「待核對」之一
describe('操作稽核:內嵌腳本之比對式不列為觸及禁區', function () {
    let t
    let privateRoot = path.resolve(FD_ROOT, '..', 'proj-private')
    before(() => {
        setGuardExtra([])
    })
    beforeEach(() => {
        t = makeTmp('guardInline')
    })
    afterEach(() => {
        t.cleanup()
    })
    let cl = (command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
    let scan = (command, opt = {}) => {
        let fp = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fp, cl(command))
        return scanTrace({ workDir: t.dir, logFile: fp, privateRoot, fileHits: 'note', ...opt }).issues
    }
    let hit = (issues, label) => issues.some((s) => s.includes(label))
    //scanAll, 回 { issues, inlineNotes }
    let scanAll = (command, opt = {}) => {
        let fp = path.join(t.dir, 'agent.log')
        fs.writeFileSync(fp, cl(command))
        return scanTrace({ workDir: t.dir, logFile: fp, privateRoot, fileHits: 'note', ...opt })
    }
    let R = String.raw
    //CP / DRV: 測試字串內之 child_process 之取用與磁碟機代號(本套件之守門掃描原始碼之字樣, 以變數組出)
    let CP = 'require(\'child_process\')'
    let DRV = 'D' + ':'

    //實例之句形: 掃描節點日誌之自我稽核腳本(比對式內含禁區工具名與帳本路徑)
    let SELF_AUDIT = [
        'W=rsi/work/abcd1234; node -e "',
        'const fs=require(\'fs\');',
        'const t=fs.readFileSync(\'$W/agent_a1.log\',\'utf8\');',
        'const lines=t.split(/\\r?\\n/);',
        'const pats={k1:/[\\s\\"\'\\\\\\\\\\/]data[\\\\\\\\\\/](ledger|eval)/g,k2:/--no-log/g,k3:/g_backtest/g,k4:/ARSI_HARNESS/g};',
        'for(const k in pats){const m=t.match(pats[k]);console.log(k,m?m.length:0)}',
        '"',
    ].join('\n')

    it('實例:自我稽核腳本之正規式內含禁區字樣 ⇒ 不列', () => {
        assert.deepEqual(scan(SELF_AUDIT), [])
    })

    it('實例:自我稽核腳本之比對式改列待核對(不計為觸及禁區、不得不列)', () => {
        let r = scanAll(SELF_AUDIT)
        assert.deepEqual(r.issues, [])
        assert(hit(r.inlineNotes, '回測期工具') && hit(r.inlineNotes, '迴圈專用之環境變數'), JSON.stringify(r.inlineNotes))
        assert(r.inlineNotes.every((s) => s.includes('內嵌腳本之比對式')), JSON.stringify(r.inlineNotes))
        //註解內之字樣亦列待核對(行註解、區塊註解)
        assert(hit(scanAll('node -e "console.log(1) // g_backtest.mjs\n"').inlineNotes, '回測期工具'), '行註解')
        assert(hit(scanAll('node -e "/* ARSI_HARNESS */ console.log(1)"').inlineNotes, '迴圈專用之環境變數'), '區塊註解')
        //比對函數之引數亦列待核對
        assert(hit(scanAll('node -e "console.log(\'x\'.includes(\'g_backtest\'))"').inlineNotes, '回測期工具'), '比對函數之引數')
        //未含禁區字樣之比對式 ⇒ 不列
        assert.deepEqual(scanAll('node -e "console.log(/abc/.test(\'x\'))"').inlineNotes, [])
    })

    it('箭頭函數之後之正規式(含 \\/\\/、\\/*、引號):其後之實際存取照列為觸及禁區', () => {
        let cases = [
            [R`node -e "const L=require('fs').readFileSync('a.log','utf8').split('\n').filter(l=>/https?:\/\//.test(l));require('fs').readFileSync('data/ledger/eval/orders.bin')"`, '帳本檔'],
            [R`node -e "const n=s.split('\n').filter(l=>/\/*/.test(l)).length;${CP}.execSync('node g_backtest.mjs')"`, '回測期工具'],
            [R`node -e "const k=t.split('\n').filter(l => /^\s*\/\//.test(l)).length; ${CP}.execSync('node g_backtest.mjs')"`, '回測期工具'],
            [R`node -e "const q=t.split('\n').filter(l=>/'/.test(l)).length;require('fs').readFileSync('${DRV}/x/proj-private/h.json')"`, '私有根'],
            [R`node -e "const q=t.split('\n').filter(l=>/'/.test(l)).length;${CP}.execSync('node ${DRV}/x/g_backtest.mjs')"`, '回測期工具'],
        ]
        for (let [cmd, label] of cases) {
            assert(hit(scanAll(cmd).issues, label), cmd)
        }
        //關鍵字之後之正規式(of、in、case 等)亦認得
        let kw = scanAll(R`node -e "for(const m of /g_backtest/.exec(t)||[])console.log(m)"`)
        assert.deepEqual(kw.issues, [], '關鍵字之後之正規式')
        assert(hit(kw.inlineNotes, '回測期工具'), JSON.stringify(kw.inlineNotes))
        //對照: 箭頭函數之正規式本身不是存取
        let f = scanAll(R`node -e "console.log(require('fs').readFileSync('a.log','utf8').split('\n').filter(l=>/g_backtest/.test(l)).length)"`)
        assert.deepEqual(f.issues, [])
        assert(hit(f.inlineNotes, '回測期工具'), JSON.stringify(f.inlineNotes))
    })

    it('列出全樹後以比對函數過濾再讀或執行、以及刻意藏於比對式者:實際之存取必在「觸及禁區」或「待核對」之一', () => {
        let cases = [
            [R`node -e "const fs=require('fs');for(const f of fs.readdirSync('.',{recursive:true}))if(f.startsWith('data/ledger/eval'))console.log(fs.statSync(f).size)"`, '帳本檔'],
            [R`node -e "const fs=require('fs');fs.readdirSync('.',{recursive:true}).filter(f=>f.includes('g_backtest')).forEach(f=>${CP}.execSync('node '+f))"`, '回測期工具'],
            [R`node -e "require('fs').readFileSync(new RegExp('data/ledger/eval/orders.bin').source)"`, '帳本檔'],
            [R`node -e "${CP}.execSync('node '+String(/g_backtest.mjs/).slice(1,-1))"`, '回測期工具'],
            [R`node -e "if(x)/[/*]/.test(s);${CP}.execSync('node g_backtest.mjs')"`, '回測期工具'],
        ]
        for (let [cmd, label] of cases) {
            let r = scanAll(cmd)
            assert(hit(r.issues, label) || hit(r.inlineNotes, label), cmd)
        }
        //被去掉之引數之字樣 ⇒ 待核對(不是觸及禁區)
        assert(hit(scanAll(cases[0][0]).inlineNotes, '帳本檔'))
    })

    //labelsOf, 原指令(只去搜尋樣式)命中之禁區字樣之名稱: 不變式之上界
    let labelsOf = (cmd) => forbiddenPats(privateRoot, false).filter(([re]) => re.test(stripSearchPatterns(cmd))).map(([, label]) => label)
    let inIssues = (r, label) => r.issues.some((s) => s.includes(`${label}(指令或路徑)`))
    let inNotes = (r, label) => r.inlineNotes.some((s) => s.startsWith(`${label}(內嵌腳本之比對式)`))
    let TPL = '`$' + '{process.cwd()}/data/ledger/eval/orders.bin`'
    let NEST = '`$' + '{s.includes(`g`)}`'
    let RAWS = '`' + DRV + '/x/proj-private/h.json`'
    //ADV, 對抗案例: 自然寫法之實際存取、刻意藏於比對式者、腳本之選項、新造之寫法、以及非存取之比對式
    let ADV = [
        R`node -e "require('fs').readFileSync('data/ledger/eval/orders.bin')"`,
        R`node -e "require('fs').readFileSync('${DRV}/proj/data/ledger/eval/orders.bin')"`,
        R`node -e "console.log(require('fs').readdirSync('/abs/proj/data/ledger/eval'))"`,
        R`node -e "${CP}.execSync('node g_backtest.mjs --pick x.mjs')"`,
        R`node -e "const p='data/ledger/'+'eval/orders.bin';require('fs').readFileSync(p)"`,
        `node -e 'require("fs").readFileSync(${TPL})'`,
        R`node -e "const p='x'.replace('x','data/ledger/eval/orders.bin');require('fs').readFileSync(p)"`,
        R`node -e "require('fs').readFileSync('data/ledger/train/a.bin'.replace('train','eval'))"`,
        R`node -e "require('fs').readFileSync('${DRV}/x/proj-private/h.json')"`,
        R`node -e "process.env.ARSI_HARNESS='1';${CP}.execSync('node g_eval.mjs')"`,
        R`node -e "const L=require('fs').readFileSync('a.log','utf8').split('\n').filter(l=>/https?:\/\//.test(l));require('fs').readFileSync('data/ledger/eval/orders.bin')"`,
        R`node -e "const n=s.split('\n').filter(l=>/\/*/.test(l)).length;${CP}.execSync('node g_backtest.mjs')"`,
        R`node -e "const k=t.split('\n').filter(l => /^\s*\/\//.test(l)).length; ${CP}.execSync('node g_backtest.mjs')"`,
        R`node -e "const fs=require('fs');fs.readdirSync('data',{recursive:true}).filter(f=>f.startsWith('ledger/eval')).forEach(f=>fs.readFileSync('data/'+f))"`,
        R`node -e "const fs=require('fs');for(const f of fs.readdirSync('.',{recursive:true}))if(f.startsWith('data/ledger/eval'))console.log(fs.statSync(f).size)"`,
        R`node -e "const fs=require('fs');fs.readdirSync('.',{recursive:true}).filter(f=>f.includes('g_backtest')).forEach(f=>${CP}.execSync('node '+f))"`,
        R`node -e "const r=/g_backtest/;${CP}.execSync('node g_backtest.mjs')"`,
        R`node -e "${CP}.execSync('node g_backtest.mjs') // just a check"`,
        R`node -e "/* g_backtest */ ${CP}.execSync('node '+'g_backtest.mjs')"`,
        R`node -e "${CP}.execSync('node g_backtest.mjs') /* "`,
        R`node -e "require('fs').readFileSync('${DRV}\\proj\\data\\ledger\\eval\\orders.bin')"`,
        R`node -p "require('fs').readFileSync('data/ledger/eval/orders.bin','utf8').length"`,
        R`node --input-type=module -e "import fs from 'fs'; fs.readFileSync('data/ledger/eval/orders.bin')"`,
        R`node -e 'require("child_process").execSync("node g_backtest.mjs")'`,
        R`node -e 'const p='\''data/ledger/eval/orders.bin'\'';require("fs").readFileSync(p)'`,
        R`node -e "require('fs').readFileSync('rsi/work/n1/agent_a1.log','utf8').match(/x/)" && cat data/ledger/eval/orders.bin`,
        R`node -e "const q=t.split('\n').filter(l=>/'/.test(l)).length;require('fs').readFileSync('${DRV}/x/proj-private/h.json')"`,
        R`node -e "const q=t.split('\n').filter(l=>/'/.test(l)).length;${CP}.execSync('node ${DRV}/x/g_backtest.mjs')"`,
        R`node -e "const q=(t.match(/'/g)||[]).length;require('fs').readFileSync('${DRV}/x/proj-private/h.json')"`,
        R`node -e "require('fs').readFileSync(new RegExp('data/ledger/eval/orders.bin').source)"`,
        R`node -e "${CP}.execSync('node '+String(/g_backtest.mjs/).slice(1,-1))"`,
        R`node -e "if(x)/[/*]/.test(s);${CP}.execSync('node g_backtest.mjs')"`,
        R`node tools/x.mjs -p "${DRV}/proj-private/a.json"`,
        R`node tools/x.mjs -e "/proj/ledger/eval/orders.bin"`,
        R`node tools/x.mjs -e "${DRV}/proj/g_backtest.mjs"`,
        R`node tools/x.mjs -p "data/ledger/eval/orders.bin"`,
        R`node tools/x.mjs -p "/abs/proj/data/ledger/eval/orders.bin"`,
        R`node -e "if(x)/'/.test(s);require('fs').readFileSync('${DRV}/x/proj-private/h.json')"`,
        R`node -e "if(x)/'/.test(s);${CP}.execSync('node ${DRV}/x/g_backtest.mjs')"`,
        R`node -e "if(x)/'/.test(s);require('fs').readFileSync('${DRV}/proj/ledger/eval/orders.bin')"`,
        R`node -e "const h=sz.in/2;require('fs').readFileSync('${DRV}/x/proj-private/h.json')"`,
        R`node -e "const k=a.of/b;${CP}.execSync('node ${DRV}/x/g_backtest.mjs')"`,
        `node -e "console.log(${NEST});require('fs').readFileSync('data/ledger/eval/x')"`,
        R`node -r ./a.cjs -r ./b.cjs -e "require('fs').readFileSync('data/ledger/eval/orders.bin')"`,
        R`node --eval="require('fs').readFileSync('data/ledger/eval/orders.bin')"`,
        R`node -e $'require("fs").readFileSync("data/ledger/eval/orders.bin")'`,
        R`node -e "const r=x.match(/a/) ? 1 : 0;require('fs').readFileSync('${DRV}/x/proj-private/h.json')"`,
        `node -e "const s=String.raw${RAWS};require('fs').readFileSync(s)"`,
        R`node -e "let a=1/2/3;require('fs').readFileSync('${DRV}/x/proj-private/h.json')"`,
        R`node -e "const t=require('fs').readFileSync('rsi/work/n1/agent_a1.log','utf8');console.log(/g_backtest/.test(t), t.includes('ARSI_HARNESS'))"`,
        R`node -e "const t=require('fs').readFileSync('a.log','utf8');const pats={k1:/ledger[\\\/]eval/g,k2:/g_backtest/g};for(const k in pats)console.log(k,(t.match(pats[k])||[]).length)"`,
        R`node -e "console.log(require('fs').readFileSync('a.log','utf8').split('\n').filter(l=>/g_backtest/.test(l)).length)"`,
        R`node -e "const ps=['g_backtest'];console.log(ps.length)"`,
    ]

    it('字樣跨越被去掉之片段之邊界(右括號後之正規式字面值內含引號):不列觸及禁區者必列待核對', () => {
        let cases = [
            [R`node -e "if(x)/'/.test(s);require('fs').readFileSync('${DRV}/x/proj-private/h.json')"`, '私有根'],
            [R`node -e "if(x)/'/.test(s);${CP}.execSync('node ${DRV}/x/g_backtest.mjs')"`, '回測期工具 g_backtest'],
            [R`node -e "if(x)/'/.test(s);require('fs').readFileSync('${DRV}/proj/ledger/eval/orders.bin')"`, '帳本檔'],
        ]
        for (let [cmd, label] of cases) {
            assert(labelsOf(cmd).includes(label), `鑑別前提: 原指令命中 ${label}`)
            let r = scanAll(cmd)
            assert.equal(inIssues(r, label), false, `鑑別前提: 去掉比對式後未命中: ${cmd}`)
            assert(inNotes(r, label), `${cmd} => ${JSON.stringify(r)}`)
        }
        //對照: 去掉比對式後仍命中之實際存取只列觸及禁區, 不重複列待核對
        let direct = scanAll(R`node -e "require('fs').readFileSync('data/ledger/eval/orders.bin')"`)
        assert(inIssues(direct, '帳本檔'), JSON.stringify(direct))
        assert.deepEqual(direct.inlineNotes, [])
    })

    it('不變式:原指令命中之每個禁區字樣,修改後必在「觸及禁區」或「待核對」之一(全部對抗案例)', () => {
        let nCases = 0
        let nHits = 0
        for (let cmd of ADV) {
            let labels = labelsOf(cmd)
            let r = scanAll(cmd)
            for (let label of labels) {
                assert(inIssues(r, label) || inNotes(r, label), `${label}: ${cmd} => ${JSON.stringify(r)}`)
                nHits++
            }
            nCases += labels.length ? 1 : 0
        }
        assert.equal(nCases, ADV.length, '鑑別前提: 每個案例之原指令皆至少命中一個字樣')
        assert(nHits >= ADV.length, `鑑別前提: 命中數 ${nHits}`)
    })

    it('專案另加之字樣帶 g 旗標:每次自頭比對,不沿用前一次之位置', () => {
        setGuardExtra([{ pattern: /zz_secret/g, label: '另加字樣' }])
        try {
            for (let k = 0; k < 3; k++) {
                assert(inIssues(scanAll('cat a/zz_secret.txt'), '另加字樣'), `第 ${k + 1} 次(實際之存取)`)
                //同一指令內出現兩次: 不得因沿用前一次之位置而誤列待核對
                let twice = scanAll('cat a/zz_secret.txt b/zz_secret.txt')
                assert(inIssues(twice, '另加字樣'), `第 ${k + 1} 次(出現兩次)`)
                assert.deepEqual(twice.inlineNotes, [], `第 ${k + 1} 次(出現兩次不列待核對)`)
                let r = scanAll('node -e "console.log(/zz_secret/.test(s))"')
                assert.deepEqual(r.issues, [], `第 ${k + 1} 次(比對式不列觸及禁區)`)
                assert(inNotes(r, '另加字樣'), `第 ${k + 1} 次(比對式列待核對)`)
            }
        }
        finally {
            setGuardExtra([])
        }
    })

    it('待核對帶指令片段:格式同觸及禁區、長度上限相同、空白壓縮', () => {
        let r = scanAll('node -e "console.log(/g_backtest/.test(s))"')
        assert.deepEqual(r.inlineNotes, ['回測期工具 g_backtest(內嵌腳本之比對式): /g_backtest/'])
        //片段為被去掉之部分本身(比對函數之引數、行註解), 不是整段指令
        assert.deepEqual(scanAll('node -e "console.log(\'x\'.includes(\'g_backtest\'))"').inlineNotes, ['回測期工具 g_backtest(內嵌腳本之比對式): \'g_backtest\''])
        assert.deepEqual(scanAll('node -e "console.log(1) // g_backtest.mjs\n"').inlineNotes, ['回測期工具 g_backtest(內嵌腳本之比對式): // g_backtest.mjs'])
        let cmt = `/* g_backtest\n\n  ${'x'.repeat(400)} */`
        let long = scanAll(`node -e "${cmt} console.log(1)"`).inlineNotes
        assert.equal(long.length, 1)
        assert.equal(long[0], `回測期工具 g_backtest(內嵌腳本之比對式): ${cmt.replace(/\s+/g, ' ').slice(0, 160)}`)
        //字樣跨越片段邊界者: 片段取自原指令(空白壓縮、長度上限相同)
        let cross = R`node -e "if(x)/'/.test(s);  require('fs').readFileSync('${DRV}/x/proj-private/h.json');console.log('${'y'.repeat(200)}')"`
        assert(cross.length > 160, '鑑別前提: 原指令超過長度上限')
        assert.deepEqual(scanAll(cross).inlineNotes.filter((s) => s.startsWith('私有根')), [`私有根(內嵌腳本之比對式): ${cross.replace(/\s+/g, ' ').slice(0, 160)}`])
    })

    it('畸形指令:帶引數之選項重複多次而無內嵌腳本 ⇒ 判定式於 1 秒內判完(不致指數回溯)', () => {
        //於子行程內量測: 判定式一旦退化為指數回溯, 同步之比對無從由測試框架中止
        let url = pathToFileURL(path.join(FD_ROOT, 'src', 'domain', 'verify.mjs')).href
        let cmds = [`node${' --import -x'.repeat(40)} y`, `node${' -r -x'.repeat(40)} y`, `node${' --require ./a.cjs'.repeat(40)} y`]
        let js = `import { stripInlinePatterns as f } from ${JSON.stringify(url)}\nlet out = JSON.parse(process.env.TEST_CMDS).map((c) => { let t0 = Date.now(); f(c); return Date.now() - t0 })\nconsole.log(JSON.stringify(out))\n`
        let c = spawnSync(process.execPath, ['--input-type=module', '-e', js], { cwd: FD_ROOT, encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, TEST_CMDS: JSON.stringify(cmds) } })
        assert.equal(c.status, 0, `子行程未於時限內結束: ${c.stderr || c.error}`)
        let ms = JSON.parse(c.stdout.trim().split('\n').slice(-1)[0])
        assert.equal(ms.length, cmds.length)
        assert(ms.every((x) => x < 1000), JSON.stringify(ms))
        //帶引數之選項之引數不以 - 起首者照舊認得其後之內嵌腳本
        assert.deepEqual(scan(R`node --import ./a.mjs -r ./b.cjs -e "console.log(/g_backtest/.test('x'))"`), [])
    })

    it('腳本之選項 -e / -p 不是內嵌腳本:其引數內之路徑照列;只有 node 之選項位置之 -e / -p 才視為內嵌腳本', () => {
        assert(hit(scan(R`node tools/x.mjs -p "${DRV}/proj-private/a.json"`), '私有根'))
        assert(hit(scan(R`node tools/x.mjs -e "/proj/ledger/eval/orders.bin"`), '帳本檔'))
        assert(hit(scan(R`node tools/x.mjs -e "${DRV}/proj/g_backtest.mjs"`), '回測期工具'))
        assert.equal(stripInlinePatterns(R`node tools/x.mjs -e "/g_backtest/"`), R`node tools/x.mjs -e "/g_backtest/"`, '不當內嵌腳本解析')
        //node 之選項在前者仍是內嵌腳本
        assert.deepEqual(scan(R`node --input-type=module -e "console.log(/g_backtest/.test('x'))"`), [])
        assert.deepEqual(scan(R`node --max-old-space-size=4096 -r ./hook.cjs -p "/g_backtest/.test('x')"`), [])
        assert.deepEqual(scan(R`"${DRV}/Program Files/nodejs/node.exe" -e "console.log(/g_backtest/.test('x'))"`), [])
    })

    it('比對函數之字串引數與 RegExp ⇒ 不列;註解內之字樣不列', () => {
        assert.deepEqual(scan('node -e "const t=\'x\';console.log(t.includes(\'g_backtest\'), t.indexOf(\'ARSI_HARNESS\'), t.startsWith(\'g_backtest\'), new RegExp(\'g_backtest\').test(t))"'), [])
        assert.deepEqual(scan('node -e "/* g_backtest */ console.log(1) // g_backtest.mjs\n"'), [])
        assert.deepEqual(scan('node -e "console.log(1) /* g_backtest.mjs */ ; console.log(2)"'), [], '區塊註解位於運算式之後')
        assert.deepEqual(scan('node --print "/g_backtest/.test(\'x\')"'), [])
        assert.deepEqual(scan('node -e \'console.log("a".split("g_backtest"))\''), [], '外層為單引號')
        assert.deepEqual(scan('node -e "console.log(\'x\'.includes(\\"g_backtest\\"))"'), [], '外層為雙引號而內層以跳脫之雙引號')
    })

    it('比對函數之清單逐一(includes、indexOf、lastIndexOf、startsWith、endsWith、match、matchAll、search、split、replace、replaceAll、RegExp):字串引數內之字樣不列為觸及禁區而列待核對;清單以外之函數(push、concat、join、readFileSync)之字串引數照列', () => {
        for (let fn of ['includes', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith', 'match', 'matchAll', 'search', 'split', 'replace', 'replaceAll']) {
            let r = scanAll(`node -e "const t='x';console.log(t.${fn}('g_backtest'))"`)
            assert.deepEqual(r.issues, [], fn)
            assert(hit(r.inlineNotes, '回測期工具'), `${fn}: 列待核對`)
        }
        for (let ctor of ['new RegExp', 'RegExp']) {
            let r = scanAll(`node -e "console.log(${ctor}('g_backtest').test('x'))"`)
            assert.deepEqual(r.issues, [], ctor)
            assert(hit(r.inlineNotes, '回測期工具'), `${ctor}: 列待核對`)
        }
        //清單以外之函數: 字串引數不知其用途 ⇒ 照列(寧可多報)
        for (let fn of ['push', 'concat', 'join', 'readFileSync', 'spawnSync']) {
            let r = scanAll(`node -e "const t=[];console.log(t.${fn}('g_backtest'))"`)
            assert(hit(r.issues, '回測期工具'), `${fn}: 照列`)
        }
        //只有第一個引數為比對式: replace 之第二個引數(置換字串)不是比對式
        assert(hit(scanAll('node -e "console.log(t.replace(\'x\', \'g_backtest\'))"').issues, '回測期工具'), 'replace 之第二個引數照列')
    })

    it('實際之存取照列:內嵌腳本之讀檔、起子行程;比對式與存取並存者亦列', () => {
        assert(hit(scan('node -e "require(\'fs\').readFileSync(\'data/ledger/eval/orders.bin\')"'), '帳本檔'), '讀帳本')
        assert(hit(scan('node -e "require(\'child_process\').spawnSync(\'node\',[\'g_backtest.mjs\'])"'), '回測期工具'), '起子行程')
        assert(hit(scan('node -e "const r=/x/g;require(\'child_process\').execSync(\'node g_backtest.mjs\')"'), '回測期工具'), '比對式與存取並存')
        //字串經變數或陣列者無從判定用途: 照列(寧可多報)
        assert(hit(scan('node -e "const ps=[\'g_backtest\'];console.log(ps.length)"'), '回測期工具'), '陣列內之字串')
    })

    it('內嵌腳本以外照舊:殼層之指令與被引號包住之路徑照列;節點(nodeRules)不適用', () => {
        assert(hit(scan('node g_backtest.mjs --pick x.mjs'), '回測期工具'))
        assert(hit(scan('node "g_backtest.mjs" --pick x.mjs'), '回測期工具'), '引號內之路徑仍是路徑')
        assert(hit(scan('cat \'data/ledger/eval/orders.bin\''), '帳本檔'))
        assert(hit(scan('node -e "console.log(1)" && node g_backtest.mjs'), '回測期工具'), '同一指令之其他段')
        assert(hit(scan(SELF_AUDIT, { nodeRules: true }), '回測期工具'), '節點搜尋禁區字樣屬探查, 照列')
    })

    //獨立複審所見(Gitea #179 之接入): 外層雙引號之內嵌腳本含 \" 時, 重組後若引號配對錯位, 其後之 grep 之樣式去不掉 ⇒ 多報(1.0.24 不多報)
    it('內嵌腳本含跳脫之雙引號而其後另有 grep 之樣式:重組後引號配對不錯位(grep 之樣式照去、不多報);樣式在腳本之外之實際存取仍列', () => {
        let cmd = 'node -e "console.log([\'a\',\'b\'].join(\'\\"\'))" && grep -rl "g_backtest" rsi/work'
        assert.deepEqual(scan(cmd), [], '奇數個跳脫之引號')
        assert.deepEqual(scan('node -e "console.log(JSON.stringify(\\"x\\"))" && grep -rl "g_backtest" rsi/work'), [], '偶數個')
        assert.deepEqual(scan('node -e "console.log(1)" && grep -rl "g_backtest" rsi/work'), [], '無跳脫(對照)')
        assert(hit(scan('node -e "console.log([\'a\'].join(\'\\"\'))" && cat data/ledger/eval/orders.bin'), '帳本檔'), '其後之實際存取仍列')
        assert(hit(scan('node -e "console.log([\'a\'].join(\'\\"\'))" && node g_backtest.mjs'), '回測期工具'), '其後之執行仍列')
        //重組後之文字與原指令之差只在被去掉之字樣(跳脫之引號原樣保留)
        assert(stripInlinePatterns(cmd).includes('join(\'\\"\')'), '\\" 原樣保留')
    })

    it('接線:做夢之待核對記入做夢文件之 harness.trace 與輪末摘要(不計為觸及禁區);重掃後照留;無待核對者不帶此鍵', async () => {
        let st = getSettings()
        let d = path.join(t.dir, 'proj')
        st.resources = {}
        st.rsi.root = path.join(d, 'rsi')
        st.records = { nodeDir: path.join(d, 'rsi/records/nodes'), dreamDir: path.join(d, 'rsi/records/dreams'), trashDir: path.join(d, 'rsi/records/trash'), workDir: path.join(d, 'rsi/work'), toolboxDir: path.join(d, 'rsi/toolbox') }
        st.eval.ledgerDir = path.join(d, 'ledger')
        fs.mkdirSync(st.eval.ledgerDir, { recursive: true })
        fs.writeFileSync(path.join(st.eval.ledgerDir, 'meta.json'), JSON.stringify({ key: 'synth' }), 'utf8')
        let cmdOf = { 1: SELF_AUDIT, 2: 'node -e "console.log(1)"' }
        let round = 0
        let dispatch = async (role, { prompt }) => {
            let m = /請閱讀 (\S+)\/brief\.md/.exec(prompt)
            let wd = path.resolve(st.FD_ROOT, m[1])
            fs.writeFileSync(path.join(wd, 'agent.log'), cl(cmdOf[round]), 'utf8')
            let dream = { audits: [], synthesis: { summary: '假', worked: [], failed: [], patterns: [], prevDirections: [] }, guidance: { directions: [], avoid: [], openQuestions: [], improvements: [], armProposals: [] }, expansion: [], docsUpdated: [] }
            fs.writeFileSync(path.join(wd, 'dream.json'), JSON.stringify(dream), 'utf8')
            return { ok: true, agent: { kind: 'fake', model: 'fake-dream', effort: 'none' } }
        }
        let P = makeProject(st, { dispatch, gate: null, catalogFile: path.join(d, 'catalog.json') })
        P.rsi.init()
        round = 1
        P.requestDreamOnly({ why: '只做夢' })
        let hk = await P.domain.hooks.afterRound({ round: 1, nodes: [] })
        assert(hk.dream, '做夢已套用(鑑別前提)')
        let tr = P.records.getDreamDoc(1).harness.trace
        assert.deepEqual(tr.issues, [], '不計為觸及禁區')
        assert(hit(tr.inlineNotes, '回測期工具'), JSON.stringify(tr))
        assert(hk.lines.some((l) => l.startsWith('做夢之操作稽核:未觸及禁區') && l.includes('待核對,不計為觸及禁區') && l.includes('回測期工具') && l.includes('迴圈專用之環境變數')), JSON.stringify(hk.lines))
        //重掃(規則改版後): 待核對照留
        P.rescanTraces()
        assert(hit(P.records.getDreamDoc(1).harness.trace.inlineNotes, '回測期工具'), '重掃後照留')
        //無待核對者不帶此鍵(做夢文件與未加本功能時同形)
        round = 2
        P.requestDreamOnly({ why: '只做夢' })
        let hk2 = await P.domain.hooks.afterRound({ round: 2, nodes: [] })
        assert(hk2.dream, '做夢已套用(鑑別前提)')
        assert.equal('inlineNotes' in P.records.getDreamDoc(2).harness.trace, false)
        assert(!hk2.lines.some((l) => l.includes('待核對,不計為觸及禁區')), JSON.stringify(hk2.lines))
    })

    it('一頁摘要(roundDigest):做夢之待核對列出(不計入觸及禁區之項數);與觸及禁區並存時兩者皆列;無待核對者不帶該句;截斷長度(每項 80 字)', () => {
        //維護者唯一看到「待核對」之處 —— 待核對不計為觸及禁區, 摘要若不列即無人知有此項(不以程式碼審查代替)
        let d = path.join(t.dir, 'digestProj')
        fs.mkdirSync(path.join(d, 'rsi', 'records', 'nodes'), { recursive: true })
        fs.mkdirSync(path.join(d, 'rsi', 'records', 'dreams'), { recursive: true })
        fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({
            eval: { ledgerDir: 'ledger' },
            rsi: { root: 'rsi' },
            records: { nodeDir: 'rsi/records/nodes', dreamDir: 'rsi/records/dreams', workDir: 'rsi/work' },
            dispatch: { skillsRoot: 'skills' },
        }), 'utf8')
        let note = (s) => `回測期工具(內嵌腳本之比對式): ${s}`
        let long = `node -e "${'x'.repeat(100)}"`
        let digestOf = (trace) => {
            fs.writeFileSync(path.join(d, 'rsi', 'records', 'dreams', 'r001.json'), JSON.stringify({ round: 1, audits: [], synthesis: {}, guidance: {}, harness: { ...(trace === undefined ? {} : { trace }) } }), 'utf8')
            let r = spawnSync(process.execPath, [path.join(FD_ROOT, 'src', 'tools', 'roundDigest.mjs'), '1'], { cwd: t.dir, env: { ...process.env, ARSI_ROOT: d }, windowsHide: true, encoding: 'utf8', timeout: 120000 })
            assert.equal(r.status, 0, r.stderr)
            let line = r.stdout.split('\n').find((l) => l.startsWith('做夢之操作稽核:'))
            assert(line, r.stdout)
            return line
        }
        //待核對 2 處、觸及禁區 0 項: 「0 項」且另列待核對之處數與各項
        let l1 = digestOf({ issues: [], inlineNotes: [note('a'), note(long)] })
        assert(l1.startsWith('做夢之操作稽核:0 項;待核對 2 處(內嵌腳本之比對式含禁區字樣,不計為觸及禁區):'), l1)
        assert(l1.includes(note('a')), '各項照列')
        let tail = l1.split('不計為觸及禁區):')[1].split(';做夢耗時')[0]
        assert(tail.split('、').every((s) => s.length <= 80), `每項截為 80 字內: ${tail}`)
        assert(tail.includes('、'), '多項以頓號連接')
        assert(!l1.includes('**'), '不計為觸及禁區 ⇒ 不出現觸及禁區之粗體項數')
        //觸及禁區 1 項與待核對 1 處並存: 項數只計觸及禁區, 待核對另列
        let l2 = digestOf({ issues: ['回測期工具(指令或路徑): node g_backtest.mjs'], inlineNotes: [note('b')] })
        assert(l2.startsWith('做夢之操作稽核:**1 項** —— 回測期工具(指令或路徑)'), l2)
        assert(l2.includes(';待核對 1 處('), l2)
        //無待核對: 不帶該句(含鍵不存在、為空陣列、做夢文件無 trace 三種)
        for (let tr of [{ issues: [] }, { issues: [], inlineNotes: [] }, undefined]) {
            let l3 = digestOf(tr)
            assert(l3.startsWith('做夢之操作稽核:0 項'), l3)
            assert(!l3.includes('待核對'), l3)
        }
    })

    it('stripInlinePatterns:只改內嵌腳本之比對字樣,其餘逐字保留', () => {
        assert.equal(stripInlinePatterns('ls data && cat a.txt'), 'ls data && cat a.txt')
        assert.equal(stripInlinePatterns('node x.mjs --pick "g_backtest"'), 'node x.mjs --pick "g_backtest"', '不是內嵌腳本')
        //內嵌腳本以外之殼層文字不當程式碼解析(分號後之絕對路徑不是正規式、// 不是註解)
        let sh = 'ls; /data/ledger/eval/x.bin && cat a // g_backtest.mjs'
        assert.equal(stripInlinePatterns(sh), sh)
        let out = stripInlinePatterns('node -e "const a=1/2/3;fs.readFileSync(\'a/b\');x.match(/g_backtest/)"')
        assert(out.includes('1/2/3'), '除法不當正規式')
        assert(out.includes('readFileSync(\'a/b\')'), '其他字串照留')
        assert.equal(out.includes('g_backtest'), false)
        //字串內之斜線與註解樣式不誤判
        assert(stripInlinePatterns('node -e "fs.readFileSync(\'http://g_backtest\')"').includes('http://g_backtest'))
        //字串以外之反斜線: \\/\\/ 不是註解之開頭(其後之程式碼照留)
        assert(stripInlinePatterns(R`node -e "a\//b;readFileSync('x')"`).includes('readFileSync(\'x\')'), '反斜線之後之斜線不與下一個斜線合成行註解')
    })
})
