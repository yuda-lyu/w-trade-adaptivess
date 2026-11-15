import fs from 'fs'
import path from 'path'
import { getSettings } from '../cfg.mjs'
import { makeProject } from '../domain/domain.mjs'

//重產並印出搜尋地圖(rsi/SEARCH_MAP.md; 規則 R-REC-14): 逐輪趨勢、各層之覆蓋、譜系、集中度之機械指標
//  node tools/searchMap.mjs            重產並印出
//  node tools/searchMap.mjs --quiet    只重產, 印一行摘要
//  唯讀樹與紀錄; 只寫 rsi/SEARCH_MAP.md(迴圈於每輪做夢前與輪末亦會隨看板重產)
let st = getSettings()
let P = makeProject(st, {})
P.rsi.init()
let r = P.writeSearchMap()
let fp = path.join(st.rsi.root, 'SEARCH_MAP.md')
if (process.argv.includes('--quiet')) {
    console.log(`搜尋地圖: 節點 ${r.nNodes}、有內容 ${r.nContent}、譜系之根 ${r.nRoots} → ${path.relative(st.FD_ROOT, fp).replace(/\\/g, '/')}`)
}
else {
    console.log(fs.readFileSync(fp, 'utf8'))
}
