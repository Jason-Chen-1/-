import asyncio, json, pathlib, subprocess
import edge_tts

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEST = ROOT / 'public/assets/voices'
DEST.mkdir(parents=True, exist_ok=True)
VOICES = {'rick': ('en-US-GuyNeural', '-5%', '-3Hz'), 'june': ('en-US-AriaNeural', '+1%', '+0Hz'), 'chad': ('en-US-ChristopherNeural', '-3%', '+3Hz')}

async def main():
    data = json.loads((ROOT / 'public/dialogue.json').read_text())
    sem = asyncio.Semaphore(3)
    async def generate(line):
        path = DEST / (line['id'] + '.mp3')
        if path.exists() and path.stat().st_size > 1000: return
        async with sem:
            voice, rate, pitch = VOICES[line['who']]
            if line['id'].startswith(('fight','aside')):
                rate = '+9%' if line['who'] != 'rick' else '+5%'
                pitch = '+3Hz'
            for attempt in range(3):
                try:
                    await asyncio.wait_for(edge_tts.Communicate(line['text'], voice, rate=rate, pitch=pitch).save(str(path)), 35)
                    print(line['id'], path.stat().st_size, flush=True)
                    return
                except Exception as exc:
                    if attempt == 2: raise
                    await asyncio.sleep(1)
    await asyncio.gather(*(generate(line) for group in data.values() for line in group))
    duration = {}
    for path in DEST.glob('*.mp3'):
        result = subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',str(path)],capture_output=True,text=True,check=True)
        duration[path.stem] = round(float(result.stdout), 3)
    (DEST / 'manifest.json').write_text(json.dumps(duration, indent=2))
    print('Complete:', len(duration), 'voice lines', flush=True)

asyncio.run(main())
