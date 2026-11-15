import path from 'path'
import { getSettings } from '../cfg.mjs'
import { createToolbox } from '../arsi/toolbox.mjs'
import { makeToolboxRules } from '../domain/toolboxRules.mjs'
import { backtestCfg } from '../domain/backtestCfg.mjs'
import { setGuardExtra, guardExtraOf } from '../domain/verify.mjs'


//共用工具區之自檢(唯讀; 不改任何檔): 以迴圈之機械檢查之同一套規則, 檢查共用工具區現有之全部檔與索引
//  node g_toolbox.mjs
//  做夢 agent 於交付前執行: 這裡列為「問題」之檔, 交付後會被迴圈逐檔還原; 不必自寫檢查腳本
//  離開碼: 0 全部合格 / 1 有問題
let st = getSettings()
setGuardExtra(guardExtraOf(st)) //專案另加之禁區字樣(與迴圈之機械檢查同一組)
let dir = st.records.toolboxDir || path.join(st.rsi.root, 'toolbox')
let rules = makeToolboxRules({ privateRoot: backtestCfg(st).privateRoot })
let tb = createToolbox({ dir, indexSeed: rules.indexSeed, checkFile: rules.checkFile, checkIndex: rules.checkIndex })
tb.ensure() //索引尚不存在時以初始內容建立(與迴圈於做夢前所做者相同)
let r = tb.inspect()
let relDir = path.relative(st.FD_ROOT, dir).replace(/\\/g, '/')
console.log(`共用工具區 ${relDir}/:${r.files.length} 個檔(不含索引 ${tb.indexFile})`)
for (let f of r.files) {
    console.log(`  ${f.problems.length ? '問題' : 'OK  '} ${f.rel}(${(f.bytes / 1024).toFixed(1)} KB)${f.problems.length ? `: ${f.problems.join(';')}` : ''}`)
}
for (let s of r.issues) {
    console.log(`  索引 / 整體: ${s}`)
}
console.log(r.ok ? '結果: 全部合格' : '結果: 有問題(列為「問題」之檔交付後會被還原;「索引未列」請補進索引)')
process.exit(r.ok ? 0 : 1)
