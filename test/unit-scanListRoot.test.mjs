import assert from 'assert/strict'
import fs from 'fs'
import path from 'path'
import { scanTrace } from '../src/domain/verify.mjs'
import { makeTmp } from './tools/synthLedger.mjs'


//操作掃描之「存取其他節點之工作夾(列出工作夾之根)」只列以工作夾之根為目標者(規則 R-BT-6; nodeRules)
//  規格: ①實際以工作夾之根為目標者才列 —— 列目錄(ls、dir、find、tree、Get-ChildItem 等以之為引數)、以之為讀取 / 遞迴搜尋之路徑引數(帶引號者亦同)
//    ②字樣只在搜尋指令(grep、rg、findstr、Select-String)之樣式引數內者不列(節點以搜尋指令在自己之紀錄檔內找含該字樣之列 —— 曾被誤列為越界)
//    ③保守: 只在能確定字樣位於樣式引數時才免列; 無法解析者(變數展開、命令替換、巢狀或不成對之引號、管線或 && 之後段難以判定者、工作目錄不確定、非指令之工具輸入)照列
//    ④「指向他節點 id 之路徑」之判定不動; 自己之工作夾內之路徑不命中(維持)⑤鍵名、訊息文字、回傳之形狀不變; nodeRules 為否或無 workRoot 時不查
describe('操作掃描之「列出工作夾之根」只列以之為目標者(規則 R-BT-6)', function () {
    let t
    let root
    let workRoot
    let wd
    let fp
    let OWN = 'aaaa111122223333'
    let OTHER = 'cccc111122223333'
    let KEY = '存取其他節點之工作夾(列出工作夾之根)'
    beforeEach(() => {
        t = makeTmp('scanListRoot')
        root = path.join(t.dir, 'proj')
        workRoot = path.join(root, 'rsi', 'work')
        wd = path.join(workRoot, OWN)
        fs.mkdirSync(wd, { recursive: true })
        fp = path.join(wd, 'agent_a1.log')
    })
    afterEach(() => {
        t.cleanup()
    })
    //兩種紀錄之格式: opencode(part.tool + part.state.input;bash 帶 workdir)與 claude(message.content 之 tool_use)
    let oc = (input) => JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { input } } })
    let cl = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
    let scan = (lines, opt = {}) => {
        fs.writeFileSync(fp, lines.join('\n'))
        return scanTrace({ workDir: wd, attempt: 1, privateRoot: path.join(t.dir, 'priv'), root, writeRoots: [wd], workRoot, nodeRules: true, ...opt })
    }
    let listed = (r) => r.issues.filter((x) => x.startsWith(KEY))
    //msgOf, 照列者之訊息 = 改前之字面(鍵 + 「: 」+ 該欄之值〔空白摺成一格、前 160 字〕)
    let msgOf = (v) => `${KEY}: ${String(v).replace(/\s+/g, ' ').slice(0, 160)}`
    //each, 每道指令於兩種格式各掃一次(opencode 帶 workdir = 專案根; claude 不帶 workdir)
    let each = (cmd, want, note) => {
        for (let [fmt, line] of [['opencode', oc({ command: cmd, workdir: root, timeout: 60000 })], ['claude', cl('Bash', { command: cmd, timeout: 60000 })]]) {
            let got = listed(scan([line]))
            if (want) {
                assert.deepEqual(got, [msgOf(cmd)], `${note}(${fmt})照列: ${cmd}`)
            }
            else {
                assert.deepEqual(got, [], `${note}(${fmt})不列: ${cmd}`)
            }
        }
    }
    let R = 'rsi/work'
    let RB = 'rsi\\work'
    let own = (sep, f) => (sep === '/' ? `${R}/${OWN}/${f}` : `${RB}\\${OWN}\\${f}`)

    it('② 字樣只在搜尋指令之樣式引數內 ⇒ 不列(路徑分隔 / 與 \\;引號單雙;grep / rg / findstr / Select-String;-e、--regexp、-m 之值、輸出之重導向、管線之後段)', () => {
        for (let [sep, Rs] of [['/', R], ['\\', RB]]) {
            each(`grep -n "DONE" ${own(sep, 'agent_a1.log')}`, false, '不含字樣(改前亦不列)')
            each(`grep -c 'DONE ${Rs}' ${own(sep, 'agent_a1.log')}`, false, '單引號之樣式')
            each(`grep -c "DONE ${Rs}" ${own(sep, 'agent_a1.log')}`, false, '雙引號之樣式')
            each(`rg "${Rs}" ${own(sep, 'notes.md')}`, false, 'rg 之樣式')
            each(`grep -c "" ${own(sep, 'agent_a1.log')}; grep -n "g_eval\\|FAILED\\|DONE ${Rs}" ${own(sep, 'agent_a1.log')} | tail -20`, false, '兩段 grep(第二段之樣式含跳脫之直線)+ 管線')
            each(`grep -e "${Rs}" ${own(sep, 'x.log')}`, false, '-e 之值')
            each(`grep --regexp="${Rs}" ${own(sep, 'x.log')}`, false, '--regexp=')
            each(`grep -m 3 "${Rs}" ${own(sep, 'x.log')}`, false, '帶值之選項(-m 3)之後為樣式')
            each(`grep --max-count 3 "${Rs}" ${own(sep, 'x.log')}`, false, '帶值之長選項(值為其後之字)之後為樣式')
            each(`grep -c -- "${Rs}" ${own(sep, 'x.log')}`, false, '-- 之後之第一個引數為樣式')
            each(`grep -A2 -inE "${Rs}" ${own(sep, 'x.log')} ${own(sep, 'y.log')}`, false, '選項之串與多個路徑引數')
            each(`grep -c "${Rs}" ${own(sep, 'x.log')} 2>/dev/null | head -3`, false, '錯誤輸出之重導向')
            each(`grep -c "${Rs}" ${own(sep, 'x.log')} > ${own(sep, 'out.txt')} 2>&1`, false, '輸出之重導向')
            each(`grep -rn "${Rs}" ${own(sep, '')}`, false, '遞迴搜尋自己之工作夾')
            each(`grep -c "${Rs}" ${own(sep, '*.log')}`, false, '自己之工作夾內之萬用字元')
            each(`rg -n -g "*.log" "${Rs}" ${own(sep, '')}`, false, 'rg 之 -g 之值')
            each(`rg -r X "${Rs}" ${own(sep, 'x.log')}`, false, 'rg 之 -r 帶值(--replace)')
            each(`cat ${own(sep, 'x.log')} | grep -c "${Rs}"`, false, '管線之後段之 grep(不遞迴、讀標準輸入)')
            each(`findstr /C:"DONE ${Rs}" ${own(sep, 'agent_a1.log')}`, false, 'findstr /C:')
            each(`findstr /N "${Rs}" ${own(sep, 'agent_a1.log')}`, false, 'findstr 之樣式')
            each(`Select-String -Pattern "${Rs}" -Path ${own(sep, 'agent_a1.log')}`, false, 'Select-String -Pattern / -Path')
            each(`Select-String "${Rs}" ${own(sep, 'agent_a1.log')}`, false, 'Select-String 之位置引數')
            each(`Get-Content ${own(sep, 'x.log')} | Select-String -SimpleMatch "${Rs}"`, false, 'Select-String 讀管線')
            each(`grep -c "${Rs}" ${own(sep, 'x.log')} && echo ok`, false, '&& 之後段無字樣')
        }
    })

    it('① 以工作夾之根為目標者照列(列目錄、讀取 / 遞迴搜尋之路徑引數,帶引號者亦同;同一指令內既有樣式又有以根為目標者);訊息與改前同', () => {
        for (let Rs of [R, RB]) {
            each(`ls ${Rs}`, true, '列目錄')
            each(`ls ${Rs}/`, true, '列目錄(尾端分隔)')
            each(`dir ${RB}`, true, 'dir(反斜線)')
            each(`find ${Rs} -name pick.mjs`, true, 'find')
            each(`tree ${Rs}`, true, 'tree')
            each(`Get-ChildItem ${Rs}`, true, 'Get-ChildItem')
            each(`grep -r foo ${Rs}`, true, '遞迴搜尋之路徑引數')
            each(`grep -r "foo" "${Rs}"`, true, '帶引號之路徑引數')
            each(`ls "${Rs}"`, true, '帶引號之列目錄')
            each(`grep -c '${Rs}' x.log; ls ${Rs}`, true, '同一指令內之他段以根為目標')
            each(`grep -c "${Rs}" ${own('/', 'x.log')} && ls ${Rs}/`, true, '&& 之後段以根為目標')
            each(`grep -c "${Rs}" ${Rs}`, true, '樣式與路徑引數皆含字樣')
            each(`rg -g "${Rs}/**" foo .`, true, 'rg 之 -g 之值(不是樣式)')
            each(`grep -f pats.txt ${Rs}`, true, '-f 給樣式檔 ⇒ 其後為路徑引數')
            each(`grep --include="${Rs}/*" -r foo .`, true, '--include 之值(不是樣式)')
        }
    })

    it('③ 樣式含字樣而路徑引數為工作夾之根之上層、無路徑引數之遞迴 / rg、或含 ~ ⇒ 照列(會讀到其他節點之工作夾)', () => {
        for (let Rs of [R, RB]) {
            for (let p of ['.', './', 'rsi', 'rsi/', root, `${R}/${OWN}/..`, `${RB}\\${OWN}\\..`, '*.log', 'rsi/*/x.log', '~/x.log']) {
                each(`grep -rc "${Rs}" ${p}`, true, `路徑引數 ${p}`)
            }
            each(`grep -rc "${Rs}"`, true, '遞迴而無路徑引數(搜尋工作目錄)')
            each(`grep -c -d recurse "${Rs}"`, true, '-d recurse 而無路徑引數')
            each(`rg "${Rs}"`, true, 'rg 無路徑引數')
            each(`findstr "${Rs}"`, true, 'findstr 無路徑引數')
        }
    })

    it('③ 無法解析者照列:變數展開、命令替換、跳脫之引號、引號不成對、群組、輸入之重導向、未知之選項或指令、樣式於引號外之萬用字元', () => {
        for (let [cmd, note] of [
            [`D=${R}; ls $D`, '變數'],
            [`eval "ls ${R}"`, 'eval'],
            [`grep "$(ls ${R})" ${own('/', 'x.log')}`, '雙引號內之命令替換'],
            [`grep "${R}" "$f"`, '雙引號內之變數'],
            [`grep -rc "${R}" $W`, '路徑引數為變數'],
            [`grep "${R}" \`cat list.txt\``, '反引號之命令替換'],
            [`grep -c "a\\" ${R}" ${own('/', 'x.log')}`, '跳脫之雙引號'],
            [`grep -c 'it\\'s ${R}' ${own('/', 'x.log')}`, '跳脫之單引號'],
            [`grep -c "${R} ${own('/', 'x.log')}`, '引號不成對'],
            [`(grep -c "${R}" ${own('/', 'x.log')})`, '子殼層之群組'],
            [`{ grep -c "${R}" ${own('/', 'x.log')}; }`, '大括號之群組'],
            [`grep -c "${R}" < ${own('/', 'x.log')}`, '輸入之重導向'],
            [`grep -c "${R}" ${own('/', 'x.log')}>out.txt`, '字中夾有 >'],
            [`grep -c "${R}" %LOG%`, '% 變數'],
            [`grep -c "${R}" ^${own('/', 'x.log')}`, '^ 跳脫'],
            [`grep --foo "${R}" ${own('/', 'x.log')}`, '未知之長選項'],
            [`grep --max "${R}" ${own('/', 'x.log')}`, '長選項之縮寫'],
            [`grep -c -J "${R}" ${own('/', 'x.log')}`, '未知之短選項'],
            [`rg --type-list "${R}" ${own('/', 'x.log')}`, 'rg 未列之長選項'],
            [`findstr /S /C:"x" /D:"${R}" *.log`, 'findstr /D:'],
            [`findstr /Q "${R}" ${own('/', 'x.log')}`, 'findstr 未列之選項'],
            [`Select-String -Pat "${R}" -Path ${own('/', 'x.log')}`, 'Select-String 之參數縮寫'],
            [`Get-Content ${own('/', 'x.log')} | Select-String -Encodin utf8 "${R}"`, 'Select-String 未列之參數(其後之字不當值)'],
            [`Select-String -Pattern "${R}" -InputObject $x`, 'Select-String -InputObject'],
            [`git grep "${R}" -- ${own('/', '')}`, 'git grep'],
            [`xargs grep -l "${R}" < files.txt`, 'xargs'],
            [`env LC_ALL=C grep -c "${R}" ${own('/', 'x.log')}`, 'env 前綴'],
            [`bash -c "grep -c '${R}' ${own('/', 'x.log')}"`, '巢狀之引號(bash -c)'],
            [`grep -c ${R}* ${own('/', 'x.log')}`, '樣式於引號外含萬用字元'],
            [`grep -c "${R}" ${own('/', 'x.log')} -m`, '帶值之選項缺值'],
            [`grep -c "${R}" ${own('/', 'x.log')} --context`, '帶值之長選項缺值'],
            [`Select-String "${R}" -Path`, 'Select-String 之參數缺值'],
        ]) {
            each(cmd, true, note)
        }
    })

    it('③ 指令本身含引號之佔位符所用之控制字元(\\u0001 / \\u0002)⇒ 無從確定、照列,且不拋錯(掃描之對象是不可信之指令字串)', () => {
        //越界之佔位符(第 5 段引號並不存在): 若無此防呆, 路徑引數之還原取不到值而拋錯, scanTrace 整個中斷
        let outOfRange = `grep -c "${R}" ${own('/', 'x.log')} \u00015\u0002`
        //偽造之佔位符(第 1 段引號 = 自己之工作夾之路徑): 若無此防呆, 末字被還原成該段而判為「路徑引數皆在自己之工作夾」⇒ 免列
        let forged = `grep -c '${R}' '${own('/', 'x.log')}' \u00011\u0002`
        for (let [cmd, note] of [[outOfRange, '越界之佔位符'], [forged, '偽造之佔位符']]) {
            for (let [fmt, line] of [['opencode', oc({ command: cmd, workdir: root })], ['claude', cl('Bash', { command: cmd })]]) {
                let r = null
                assert.doesNotThrow(() => {
                    r = scan([line])
                }, `${note}(${fmt})不拋錯`)
                assert.deepEqual(listed(r), [msgOf(cmd)], `${note}(${fmt})照列`)
            }
        }
        //鑑別前提: 同一指令去掉控制字元之字(只剩引號內之樣式與自己之工作夾之路徑)⇒ 免列
        assert.deepEqual(listed(scan([oc({ command: `grep -c '${R}' '${own('/', 'x.log')}'`, workdir: root })])), [], '鑑別前提: 無控制字元者免列')
    })

    it('③ 工作目錄不確定者照列:workdir 不是專案根、指令內或此前之指令切換目錄(cd / Set-Location 等);此後帶 workdir = 專案根之呼叫照常免列', () => {
        let g = `grep -c "${R}" ${own('/', 'x.log')}`
        assert.deepEqual(listed(scan([oc({ command: g, workdir: root })])), [], '鑑別前提: workdir = 專案根 ⇒ 不列')
        assert.deepEqual(listed(scan([oc({ command: g, workdir: '.' })])), [], 'workdir 為相對路徑而解析為專案根')
        assert.deepEqual(listed(scan([oc({ command: g, workdir: path.join(root, 'rsi') })])), [msgOf(g)], 'workdir 為他處')
        assert.deepEqual(listed(scan([oc({ command: g, workdir: 3 })])), [msgOf(g)], 'workdir 非字串')
        assert.deepEqual(listed(scan([JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { input: { command: g, cwd: path.join(root, 'rsi') } } } })])), [msgOf(g)], 'cwd 欄亦同')
        for (let c of [`cd rsi && grep -rc "${R}" work`, `pushd rsi; grep -c "${R}" ${own('/', 'x.log')}`, `Set-Location rsi; Select-String "${R}" ${own('/', 'x.log')}`]) {
            assert.deepEqual(listed(scan([cl('Bash', { command: c })])), [msgOf(c)], `指令內切換目錄: ${c}`)
        }
        assert.deepEqual(listed(scan([cl('Bash', { command: 'cd rsi' }), cl('Bash', { command: g })])), [msgOf(g)], '此前之指令切換目錄(未帶 workdir)')
        assert.deepEqual(listed(scan([cl('Bash', { command: 'sl rsi' }), cl('Bash', { command: g })])), [msgOf(g)], '此前之指令 sl')
        assert.deepEqual(listed(scan([cl('Bash', { command: g }), cl('Bash', { command: 'cd rsi' })])), [], '切換目錄在後者不影響之前')
        assert.deepEqual(listed(scan([oc({ command: 'cd rsi', workdir: root }), oc({ command: g, workdir: root })])), [], '此後之呼叫帶 workdir = 專案根')
    })

    it('③④⑤ 指令以外之欄照現行(路徑、樣式、說明、寫入程式檔之內容);他節點 id 與其他判定不受影響;nodeRules 為否或無 workRoot 不查;回傳之形狀不變', () => {
        //③ 搜尋工具之樣式欄、說明欄: 照現行之寬判
        assert.deepEqual(listed(scan([cl('Grep', { pattern: `DONE ${R}`, path: `${R}/${OWN}` })])), [msgOf(`DONE ${R}`)], '搜尋工具之 pattern 欄')
        let d = `搜尋 ${R} 之字樣`
        assert.deepEqual(listed(scan([cl('Bash', { command: `grep -c "x" ${own('/', 'x.log')}`, description: d })])), [msgOf(d)], 'Bash 之 description 欄')
        let code = `import fs from 'fs'\nconsole.log(fs.readdirSync('${R}'))\n`
        assert.deepEqual(listed(scan([cl('Write', { file_path: path.join(wd, 'peek.mjs'), content: code })])), [msgOf(code)], '寫入程式檔之內容')
        let sh = `grep -c "DONE ${R}" ${own('/', 'agent_a1.log')}\n`
        assert.deepEqual(listed(scan([cl('Write', { file_path: path.join(wd, 'check.sh'), content: sh })])), [msgOf(sh)], '寫入腳本檔之內容(形同指令者亦照現行)')
        //④ 他節點 id 之路徑: 照列(與本案無關之判定)
        let o = `grep -c "${R}" ${R}/${OTHER}/x.log`
        let r = scan([oc({ command: o, workdir: root })])
        assert.deepEqual(r.issues, [`存取其他節點之工作夾(${OTHER.slice(0, 12)}): ${o}`], `樣式之字樣免列、他節點之路徑照列: ${JSON.stringify(r.issues)}`)
        assert.deepEqual(scan([oc({ command: o, workdir: root })], { allowWork: [OTHER] }).issues, [], '他節點在 allowWork 內 ⇒ 皆不列')
        //④ 其他判定照舊: 迴圈驗證之程式、寫到工作夾外
        let v = scan([oc({ command: `grep -c "${R}" src/domain/verify.mjs`, workdir: root })])
        assert(v.issues.some((x) => x.startsWith('觸及禁區: 回測期重放 / 迴圈驗證之程式')) && !listed(v).length, JSON.stringify(v.issues))
        let w = scan([oc({ command: `grep -c "${R}" ${own('/', 'x.log')} > tmp/out.txt`, workdir: root })])
        assert.deepEqual(w.issues, [`寫到工作夾外(tmp/out.txt): grep -c "${R}" ${own('/', 'x.log')} > tmp/out.txt`])
        //⑤ nodeRules 為否、無 workRoot ⇒ 不查(照列之指令亦不列)
        assert.deepEqual(listed(scan([cl('Bash', { command: `ls ${R}` })], { nodeRules: false })), [])
        assert.deepEqual(listed(scan([cl('Bash', { command: `ls ${R}` })], { workRoot: null })), [])
        //⑤ 回傳之形狀
        assert.deepEqual(Object.keys(scan([cl('Bash', { command: `grep -c "${R}" ${own('/', 'x.log')}` })])), ['issues', 'note', 'nEvals', 'fileNotes', 'inlineNotes', 'planAfterEval'])
        //④ 自己之工作夾內之路徑不命中(改前即然)
        assert.deepEqual(listed(scan([cl('Bash', { command: `ls ${R}/${OWN}/ && cat ${RB}\\${OWN}\\brief.md` })])), [])
    })
})
