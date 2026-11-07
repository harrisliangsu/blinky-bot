import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
const bundle=await build({entryPoints:['src/main/agent/skillsGateway.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'inventory-boundary',setup(b){
 b.onResolve({filter:/^\.\.\/skills$/},a=>({path:a.path,namespace:'fixture'}))
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const skillsFor=async(backend,query)=>{globalThis.__globalSkillCalls.push({backend,query});return ['one','two'].map(name=>({name,description:'Global skill',path:'/fixture/'+name}))};export {skillsPromptSection} from '${process.cwd()}/src/main/skills/prompt.ts'`,loader:'js',resolveDir:process.cwd()}))
}}]})
const {skillsSection}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
for(const selection of [[],['agents:one']]) test(`global skills are available with legacy Bot selection ${JSON.stringify(selection)}`,async()=>{
 globalThis.__globalSkillCalls=[]
 const result=await skillsSection({name:'Fixture',backendId:'grok',skills:selection},{cwd:'/fixture/workspace'})
 assert.match(result,/one.*\/fixture\/one\/SKILL.md/);assert.match(result,/two.*\/fixture\/two\/SKILL.md/)
 assert.deepEqual(globalThis.__globalSkillCalls,[{backend:'grok',query:{cwd:'/fixture/workspace'}}])
})
