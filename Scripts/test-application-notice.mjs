import { build } from 'esbuild'
import { createRequire } from 'node:module'
import path from 'node:path'

const result = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import assert from 'node:assert/strict'
    import { renderToStaticMarkup } from 'react-dom/server'
    import { ApplicationNotice } from './src/renderer/src/components/ApplicationNotice'
    import { visibleAssistantText } from './src/renderer/src/lib/messagePresentation'
    import { toProviderMessages } from './src/main/agent/history'
    const message = { id:'receipt',role:'assistant' as const,content:'已停止，业务请求未发出。',createdAt:1,uiOnly:true }
    const rendered = renderToStaticMarkup(<ApplicationNotice message={message} />)
    assert.ok(rendered.includes(message.content))
    assert.ok(rendered.includes('role="note"'))
    assert.ok(!rendered.includes('ob-msg-assistant'))
    assert.equal(visibleAssistantText(message),'')
    assert.deepEqual(toProviderMessages([message],{supportsVision:false}),[])
    assert.equal(renderToStaticMarkup(<ApplicationNotice message={{...message,internal:true}} />),'')
    assert.equal(renderToStaticMarkup(<ApplicationNotice message={{...message,uiOnly:false}} />),'')
    assert.ok(renderToStaticMarkup(<ApplicationNotice message={{...message,content:'<script>literal</script>'}} />).includes('&lt;script&gt;'))
    const safe = renderToStaticMarkup(<ApplicationNotice message={{...message,content:'raw discarded',displayContent:'安全状态'}} />)
    assert.ok(safe.includes('安全状态')&&!safe.includes('raw discarded'))
    console.log(JSON.stringify({ok:true,visibleReceipt:true,separateFromModelAnswer:true,excludedFromModelContext:true,internalHidden:true,literalTextEscaped:true,displayProjectionPreserved:true}))
  ` },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' }
})
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(path.resolve('package.json')), module, module.exports)
