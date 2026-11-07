"""Analyze and arrange real Electron screenshots; never edits product imagery."""
from pathlib import Path
from PIL import Image, ImageDraw
import numpy as np
import json,hashlib,os
base=Path('docs/test-evidence/avatar-20261106');assets=Path('src/renderer/src/assets/avatars');layers=json.loads((assets/'layers.json').read_text())
colors=['cream','lavender','lilac','sky','mint','sage','butter','apricot','peach','rose','mist'];palette=json.loads((assets/'palette.json').read_text());shapes=list(layers)
report={'sample':'Forehead samples from actual Electron creation preview. Nose samples should stay constant across colours.','faceSamples':{},'noseMaxChannelSpread':{},'combinations':0,'themes':['dark','light']}
ears=dict(zip(shapes,[(180,960),(373,740),(195,910),(210,760),(180,945),(190,900),(165,925),(150,920),(180,900),(170,900),(170,930),(250,930),(170,920)]))
report['earMaxChannelSpread']={}
for theme in ['dark','light']:
 bg='#242424' if theme=='dark' else '#FAFAFA';fg='white' if theme=='dark' else '#303030';sheet=Image.new('RGB',(12*112,14*118),bg);draw=ImageDraw.Draw(sheet)
 for c,color in enumerate(colors):draw.text(((c+1)*112+5,6),color,fill=fg)
 for r,shape in enumerate(shapes):
  draw.text((5,(r+1)*118+40),shape,fill=fg);d=layers[shape];foreheads=[];noses=[];ear_samples=[]
  source=np.asarray(Image.open(assets/'source'/f'{shape}.png'));ex,ey=ears[shape];assert source[ey,ex,3]>=250
  for c,color in enumerate(colors):
   im=Image.open(base/'tiles'/f'{shape}-{color}-{theme}.png').convert('RGB');w,h=im.size
   # The preview has a 112 CSS-pixel square SVG and 4 CSS pixels of vertical padding.
   side=h*112/120;vx,vy,vw,vh=map(float,d['viewBox'].split());eye=d['eyes'][0];x=sum(e['cx'] for e in d['eyes'])/2;y=eye['cy']-eye['ry']*1.9
   def sample(x,y):
    xx=round((w-side)/2+(x-vx)*side/vw);yy=round((h-side)/2+(y-vy)*side/vh);return np.asarray(im)[yy-1:yy+2,xx-1:xx+2].mean((0,1)).round(2).tolist()
   foreheads.append(sample(x,y));noses.append(sample(x,eye['cy']+eye['ry']*.66));ear_samples.append(sample(ex,ey))
   im=im.crop(((w-h)//2,0,(w+h)//2,h));im.thumbnail((110,110));sheet.paste(im,((c+1)*112,(r+1)*118));report['combinations']+=1
  report['faceSamples'][shape+'-'+theme]=dict(zip(colors,foreheads));report['noseMaxChannelSpread'][shape+'-'+theme]=np.ptp(np.array(noses),axis=0).tolist()
  report['earMaxChannelSpread'][shape+'-'+theme]=np.ptp(np.array(ear_samples),axis=0).tolist()
  assert len(set(tuple(v) for v in foreheads))==11,(shape,theme,'colours did not all change the actual face')
 sheet.save(base/f'all-143-{theme}.png')
report['all143ActuallyTintedInBothThemes']=True
report['allOriginalsPreserved']=all(hashlib.sha256((assets/'source'/f'{s}.png').read_bytes()).hexdigest()==layers[s]['sourceSha256'] for s in shapes)
build_root=Path(os.environ.get('BLINKY_AVATAR_BUILD_ROOT','.'))
report['buildRoot']=str(build_root.resolve())
output_hashes={hashlib.sha256(p.read_bytes()).hexdigest() for p in (build_root/'out/renderer/assets').glob('*.png')}
report['all26RasterAssetsBundled']=all(hashlib.sha256(p.read_bytes()).hexdigest() in output_hashes for folder in ['source','plates'] for p in (assets/folder).glob('*.png'))
report['allNosesRetainOriginalColour']=all(max(v)<=1 for v in report['noseMaxChannelSpread'].values())
report['allEarsStayUntinted']=all(max(v)<=1 for v in report['earMaxChannelSpread'].values())
assert report['allOriginalsPreserved'] and report['all26RasterAssetsBundled'] and report['allNosesRetainOriginalColour'] and report['allEarsStayUntinted'],{key:value for key,value in report.items() if 'Spread' in key}
(base/'pixel-and-bundle-checks.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in ['faceSamples','noseMaxChannelSpread','earMaxChannelSpread']},indent=2))
