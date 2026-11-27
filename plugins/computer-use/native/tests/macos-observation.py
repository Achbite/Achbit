#!/usr/bin/env python3
"""Packaged macOS regression: use only this process's AppKit window and a local Responses fixture.
Usage: python3 macos-observation.py ABS_DEBUG_PACKAGE ABS_NEW_RUN_DIRECTORY [ax|visual|coords]
Default is AX-only, with a text-only fixture profile. Run visual separately to authorize actual single-window capture.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main(package, root, kind='ax'):
    assert kind in ('ax', 'visual', 'coords')
    coords = kind == 'coords'
    visual = kind == 'visual'
    assert sys.platform == 'darwin'
    os.umask(0o077)
    contents = package / 'Achbit-Debug.app/Contents'
    build = json.loads((contents / 'Resources/BUILDINFO.json').read_bytes())
    assert build['buildKind'] == 'debug' and build['debugControl']
    subprocess.run(['codesign', '--verify', '--strict', '--deep', contents.parent], check=True)
    root.mkdir()  # Refuse live state and previously used fixture targets.
    state, work = root / 'state', root / 'workspace'
    work.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ACHBIT_', 'OPENAI_'))
           and k.lower() not in ('all_proxy', 'https_proxy', 'http_proxy')}
    env.update(ACHBIT_USER_ROOT=str(state), ACHBIT_RUNTIME_DIR=str(contents / 'Resources'),
               ACHBIT_KERNEL_BIN=str(contents / 'MacOS/achbit-kernel'), ACHBIT_PORT='0', NO_PROXY='localhost,127.0.0.1')
    report = {'build': build, 'runs': [], 'case':kind}
    def save(name, value):
        p = root / name
        p.write_text(json.dumps(value, indent=2, ensure_ascii=False))
        return p
    def cli(*args):
        res = subprocess.run([contents / 'MacOS/achbit-cli', *map(str, args)], env=env, cwd=work,
                             capture_output=True, text=True, timeout=120)
        if res.returncode:
            raise RuntimeError(f'{args[:3]}: {res.stderr[-800:]} {res.stdout[-400:]}')
        return res.stdout
    def debug(*args):
        return cli('debug', *args, '--state-root', state)
    def configure(*args):
        return cli('--host-data-dir', state / 'data', *args)
    def archive(view):
        assert view['truncated'] and 'archiveError' not in view
        detail = view['fullOutput']
        p = Path(detail['path']).resolve(strict=True)
        assert (state / 'data/agent-runtime/tool-record.outputs').resolve() in p.parents
        raw = p.read_bytes()
        assert len(raw) == detail['bytes'] and len(raw) > 32768
        return json.loads(raw), p, len(raw)
    def check_window(value, images, wire_bytes, name):
        assert value.get('window', {}).get('windowId') == target['windowId'], str(value)[:650]
        assert value['app'] == target['app'] and value['window']['pid'] == target['pid']
        assert value['hasScreenshot'] is visual
        if visual:
            assert value['modelImages'] and images > 0
        else:
            assert images == 0 and 'modelImages' not in value and 'artifacts' not in value
        view = value['observationView']
        original, path, raw_bytes = archive(view)
        assert original['observationId'] == value['observationId']
        rows, sample = original['elements'], value['elements']
        assert len(sample) < len(rows) == view['totalElements'] and wire_bytes < 40*1024
        def live(row):
            return row.get('role') == 'AXButton' and 'Verify retained control' in (row.get('title'), row.get('description'))
        button = next(row for row in sample if live(row))
        assert button.get('enabled') is not False and 'AXPress' in button['actions']
        n = next(i for i, row in enumerate(rows) if row['elementId'] == button['elementId'])
        assert live(rows[n]) and rows[n]['bounds'] == button['bounds']
        shown = {r['elementId'] for r in sample}
        gray = [r for r in rows[:n] if r.get('enabled') is False and 'AXPress' in r.get('actions', [])]
        assert any(r['elementId'] not in shown for r in gray), (len(rows), n, len(gray))
        points = button['boundsWindowPoints']; center = button['centerWindowPoints']
        assert center == {'x':points['x']+points['width']/2,'y':points['y']+points['height']/2}
        report[name] = dict(rawBytes=raw_bytes, wireTextBytes=wire_bytes, elements=len(rows), inline=len(sample),
                            disabledBefore=len(gray), omittedDisabled=sum(r['elementId'] not in shown for r in gray),
                            retained=button['elementId'], centerWindowPoints=center)
        if visual:
            png = Path(original['contentRef']).resolve(strict=True)
            image = png.read_bytes()
            assert png.parent == path.parent and image[:8] == b'\x89PNG\r\n\x1a\n'
            assert struct.unpack('>II', image[16:24]) == (original['width'], original['height'])
            assert button['boundsImagePixels'] == button['bounds'] and value['frame']['displayTime'] > 0
            marker = json.loads(subprocess.check_output([exe,'--marker',png], text=True))
            report[name].update(pngBytes=len(image),dimensions=[original['width'],original['height']],marker=marker,
                                displayTime=value['frame']['displayTime'],sequence=value['frame']['sequence'])
            assert marker['red' if name == 'observe' else 'green'] > 100, marker
        else:
            assert not (set(original) & {'contentRef','width','height','sharing','frame'}) and not list(path.parent.glob('*.png'))
            assert button['bounds'] == points and 'boundsImagePixels' not in button and value['coordinateSpace'] == 'windowPoints'
        return button['elementId']

    # Build only the disposable fixture with the local AppKit SDK; the plugin itself comes from the signed Debug package.
    app = root / 'Target.app/Contents'; exe = app / 'MacOS/Target'; exe.parent.mkdir(parents=True)
    bundle = 'org.achbit.qa.observation.' + uuid.uuid4().hex
    (app / 'Info.plist').write_bytes(plistlib.dumps(dict(CFBundleExecutable='Target', CFBundleIdentifier=bundle,
        CFBundleName='Achbit QA', CFBundlePackageType='APPL', LSUIElement=True, NSPrincipalClass='NSApplication')))
    subprocess.run(['xcrun', 'clang', '-mmacosx-version-min=15.2', '-fobjc-arc', '-Wno-deprecated-declarations', '-framework', 'AppKit', '-framework', 'CoreGraphics',
                    Path(__file__).with_name('observation-window.m'), '-o', exe], check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', app.parent], check=True)
    target_process = subprocess.Popen([exe, root], env=env, stdout=subprocess.DEVNULL)
    failed, frozen, turn = [], {}, 0
    expected = [('status','completed'),('observe','completed'),('press','completed')]
    if not visual: expected.append(('setValue','completed'))
    expected.extend([('status','completed'),('observe','failed')])
    last = len(expected)+2
    if visual:
        expected[1:1] = [('capture','completed'),('status','completed')] + [('observe','completed')]*9
    if coords:
        expected = [(a,b) for a,b in [('status','completed'),('observe','completed'),('click','failed'),('observe','completed'),
            ('click','completed'),('click','failed'),('observe','completed'),('press','failed'),('observe','completed'),('press','failed'),('status','completed')]]
    target, sid, owned = {}, None, False
    def signal(command, ack):
        (root/command).touch()
        for _ in range(50):
            if (root/ack).exists(): return
            assert target_process.poll() is None; time.sleep(.1)
        probe = root / 'fixture-hit.json'
        raise AssertionError((ack, json.loads(probe.read_bytes()) if probe.exists() else 'no fixture hit probe'))
    def step(body):
        nonlocal turn
        turn += 1
        assert body['model'] == 'mac-qa' and turn <= len(expected)+2 and not failed
        phase = (3 if turn <= 14 else turn-11) if visual and turn >= 5 else turn
        assert any(t.get('name') == 'computer_control' for t in body['tools'])
        text = {i['call_id']: i['output'] for i in body['input'] if i.get('type') == 'function_call_output'}
        images = sum(p.get('type') == 'input_image' for i in body['input'] if isinstance(i.get('content'), list) for p in i['content'])
        def value(key):
            out = json.loads(text[key]); assert 'error' not in out, str(out)[:850]
            return out.get('result', out)
        def call(key, args):
            return dict(type='function_call', id='fc-'+key, call_id=key, name='computer_control', arguments=json.dumps(args), status='completed')
        observe = dict(action='observe', app=target['app'], windowId=target['windowId'], mode='background')
        if visual: observe['includeScreenshot'] = True
        if coords:
            observe['mode'] = 'foreground'
            assert images == 0
            if turn >= 3:
                def checked_click(key, name, coords):
                    obs = value(key)
                    button = next(r for r in obs['elements'] if r.get('role')=='AXButton' and 'Verify retained control' in (r.get('title'),r.get('description')))
                    report[name+'Point'] = button['centerWindowPoints']
                    return call(name, dict(action='click',app=bundle,observationId=obs['observationId'],**button['centerWindowPoints'],**coords))
                def rejected(key, reason):
                    bad = json.loads(text[key]); assert reason in bad['error']['message'], bad['error']
                    assert not bad.get('result',{}).get('dispatched'); report[key]=bad['error']['message']
                if turn == 3: return checked_click('observe','unmarked',{})
                if turn == 4:
                    rejected('unmarked','coordinateSpace=windowPoints'); return call('pointObs',observe)
                if turn == 5:
                    signal('pass-point', 'pass-ready.json'); probe = json.loads((root/'pass-ready.json').read_bytes())
                    assert probe['hit'] == 'target' and probe['ignoresMouse'] and probe['pointInPanel']
                    report['passThrough'] = probe
                    return checked_click('pointObs','pointClick',{'coordinateSpace':'windowPoints'})
                if turn == 6:
                    assert value('pointClick')['dispatched'] and value('pointClick')['hasScreenshot'] is False
                    assert json.loads((root/'effects.json').read_bytes()) == {'enabled':1,'disabled':0}
                    signal('cover-point', 'cover-ready.json'); probe = json.loads((root/'cover-ready.json').read_bytes())
                    assert probe['hit'] == 'panel' and not probe['ignoresMouse'] and probe['pointInPanel']
                    assert probe['panel'] == report['passThrough']['panel']; report['intercepting'] = probe
                    return checked_click('pointClick','covered',{'coordinateSpace':'windowPoints'})
                if turn == 7:
                    rejected('covered','covered by another window'); signal('uncover-point','uncovered.json'); return call('grayObs',observe)
                if turn == 8:
                    obs=value('grayObs'); gray=next(r for r in obs['elements'] if r.get('enabled') is False and 'AXPress' in r.get('actions',[]))
                    return call('gray',dict(action='press',app=bundle,observationId=obs['observationId'],elementId=gray['elementId']))
                if turn == 9: rejected('gray','disabled'); return call('moveObs',observe)
                if turn == 10:
                    obs=value('moveObs'); eid=check_window(obs,images,len(text['moveObs'].encode()),'beforeMove'); signal('move-window','moved.json')
                    return call('moved',dict(action='press',app=bundle,observationId=obs['observationId'],elementId=eid))
                if turn == 11: rejected('moved','moved or resized'); return call('after',{'action':'status'})
                if turn == 12:
                    report['after']=value('after')['sharing']['executorCaptureCounts']; assert report['after']==report['before']
                    frozen['pointClick']=text['pointClick']
                else: assert turn==13 and text['pointClick']==frozen['pointClick']
                return dict(type='message',id='coords-'+str(turn),role='assistant',status='completed',content=[dict(type='output_text',text='Fixture checked.',annotations=[])])
        if turn == 1: return call('status', {'action':'status'})
        if turn == 2:
            status = value('status'); executor = status['executor']; perms = status['permissions']
            report['permissions'] = perms
            assert perms['accessibility'] and (not visual or perms['screenCapture']), f'Debug helper lacks existing permission: {perms}'
            assert status['capabilities']['observationContract'] == 'ax-default'
            report['before'] = status['sharing']['executorCaptureCounts']
            assert not any(report['before'].values())
            installed = contents / 'Helpers/Achbit Debug Computer Use.app'
            runtime = Path(executor['executable']).resolve(strict=True)
            assert Path(executor['installedBundlePath']).resolve() == installed.resolve() and (state / 'cache') in runtime.parents
            binary = installed / 'Contents/MacOS/Achbit-Computer-Use'
            digest = hashlib.sha256(runtime.read_bytes()).hexdigest()
            assert digest == hashlib.sha256(binary.read_bytes()).hexdigest()
            report['helper'] = dict(pid=executor['pid'],sha256=digest,bundle=executor['bundleId'])
            return call('single', {'action':'capture','windowId':target['windowId']}) if visual else call('observe',observe)
        if visual and turn == 3:
            one = value('single')
            assert one['captureId'] and 'observationId' not in one and one['target'] == {'windowId': target['windowId']}
            artifact, = one['artifacts']
            assert 'contentRef' not in one and 'contentRef' not in artifact  # Model projection, not the immutable tool record.
            aid = artifact['artifactId']
            assert artifact['uri'] == 'artifact://' + aid and artifact['contentType'] == 'image/png'
            assert one['modelImages'] == [{'artifactId': aid, 'purpose': 'observation'}] and images == 1
            part, = (p for i in body['input'] if isinstance(i.get('content'), list) for p in i['content'] if p.get('type') == 'input_image')
            prefix = 'data:image/png;base64,'
            assert part['image_url'].startswith(prefix), 'Expected an inline PNG, not a URL or a placeholder'
            image = base64.b64decode(part['image_url'][len(prefix):], validate=True)
            assert image[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', image[16:24]) == (one['width'], one['height'])
            report['singleImage'] = dict(captureId=one['captureId'], artifactId=aid, bytes=len(image), sha256=hashlib.sha256(image).hexdigest())
            return call('single-state', {'action':'status'})
        if visual and turn == 4:
            one = value('single-state')['sharing']; assert one['state'] == 'inactive'
            report['singleShot'] = one['executorCaptureCounts']
            assert report['singleShot'] == dict(enumerations=1,pngWrites=1,targetStreamStarts=0,pointerStreamStarts=0,singleShots=1)
            return call('observe',observe)
        if phase == 3:
            key = f'repeat{turn-5}' if visual and turn > 5 else 'observe'
            obs = value(key)
            if key == 'observe':
                eid = check_window(obs, images, len(text[key].encode()), 'observe')
                if visual: report['visualSequence'] = []
            if visual:
                assert images > 0 and obs['window']['windowId'] == target['windowId'] and obs['modelImages']
                seen = report['visualSequence']; assert all(i['id'] != obs['observationId'] and i['generation'] == obs['sharing']['generation'] for i in seen)
                seen.append({'id':obs['observationId'],'generation':obs['sharing']['generation'],'frame':obs['frame']['sequence']})
                if len(seen)<10: return call('repeat'+str(len(seen)),observe)
                eid = next(r['elementId'] for r in obs['elements'] if r.get('role')=='AXButton' and 'Verify retained control' in (r.get('title'),r.get('description')))
            return call('press', dict(action='press', app=bundle, observationId=obs['observationId'], elementId=eid))
        if phase == 4:
            pressed = value('press'); assert pressed['dispatched'] and pressed['observationId'] != value('observe')['observationId']
            check_window(pressed, images, len(text['press'].encode()), 'press')
            assert json.loads((root / 'effects.json').read_bytes()) == {'enabled':1,'disabled':0}
            if not visual:
                field = next(r for r in pressed['elements'] if r.get('role') == 'AXTextField' and r.get('valueSettable'))
                return call('set', dict(action='setValue',app=bundle,observationId=pressed['observationId'],elementId=field['elementId'],text='After'))
            assert report['press']['displayTime'] > report['observe']['displayTime']
            return call('after', {'action':'status'})
        if not visual and turn == 5:
            updated = value('set'); assert updated['dispatched'] and updated['valueVerification']['matched'] and updated['valueVerification']['actual'] == 'After'
            assert json.loads((root/'value.json').read_bytes())['actual'] == 'After'
            check_window(updated, images, len(text['set'].encode()), 'setValue')
            return call('after', {'action':'status'})
        if phase == last-2:
            after = value('after')['sharing']; report['after'] = after['executorCaptureCounts']
            assert after['state'] == ('active' if visual else 'inactive')
            assert report['after'] == dict(enumerations=2*int(visual),targetStreamStarts=int(visual),pointerStreamStarts=0,singleShots=int(visual),pngWrites=12*int(visual)), report['after']
            (root / 'unbacked-windows').touch()  # Changes fixture AXWindows only, never the helper or its permissions.
            for _ in range(50):
                if (root / 'unbacked-ready.json').exists(): break
                assert target_process.poll() is None; time.sleep(0.1)
            assert (root / 'unbacked-ready.json').exists()
            return call('unmatched', observe)
        if phase == last-1:
            bad = json.loads(text['unmatched']); error = bad['error']; d = bad['result']['diagnostics']
            assert error['code'] == 'native_browser_failed' and '0 exact AX matches' in error['message'], str(error)
            raw, _, nb = archive(d['observationView']); assert raw['ok'] is False and raw['message'] == error['message']
            assert d['phase'] == 'computer:observe' and d['target']['stage'] == 'AXWindowIdentity'
            original, inline = raw['diagnostics']['target'], d['target']
            assert inline['targetPid'] == target['pid'] and inline['windowId'] == target['windowId']
            assert inline['nativeCode'] == original['nativeCode'] and 'observationId' not in bad['result']
            for k in ('errors','candidateErrors'):
                assert len(original[k]) == d['observationView']['diagnosticCounts'][k] == 300
                assert 0 < len(inline[k]) <= 8 and inline[k] == original[k][:len(inline[k])]
            assert len(text['unmatched'].encode()) <= 32768
            report['failure'] = dict(rawBytes=nb, wireTextBytes=len(text['unmatched'].encode()), error=error['message'],
                stage=inline['stage'], nativeCode=inline['nativeCode'], counts=d['observationView']['diagnosticCounts'],
                inline={k:len(inline[k]) for k in ('errors','candidateErrors')})
            frozen.update({k:text[k] for k in ('observe','press','unmatched')})
        else:
            assert all(text[k] == v for k,v in frozen.items()) and images == 0
            report['replayedWithoutPixels'] = True
        return dict(type='message', id='answer-'+str(turn), role='assistant', status='completed',
                    content=[dict(type='output_text',text='Fixture inspection complete.',annotations=[])])
    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            try:
                assert self.path == '/v1/responses'
                item = step(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                stream = [dict(type='response.output_item.done', output_index=0,item=item),
                          dict(type='response.completed', response=dict(id='r-'+str(turn), status='completed',usage=dict(input_tokens=200,output_tokens=24)))]
                data = ''.join('data: '+json.dumps(p)+'\n\n' for p in stream).encode()
                self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
            except Exception:
                failed.append(traceback.format_exc()); self.send_error(400,'Fixture assertion failed')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        for _ in range(80):
            if (root / 'target.json').exists(): break
            assert target_process.poll() is None; time.sleep(0.1)
        target = json.loads((root / 'target.json').read_bytes())
        assert target['pid'] == target_process.pid and target['app'] == bundle and target['windowId'] > 0
        report['target'] = target
        launch = json.loads(debug('launch', '--artifact', package, '--workspace', work, '--headless'))
        owned = launch['ownsHost']; assert owned and Path(launch['artifact']).resolve() == package
        key = root / 'fixture-key'; key.write_text('local-only')
        try:
            configure('connections','set','--input',save('connection.json',dict(connection=dict(id='mac-local',name='Mac fixture',adapterId='custom',
                billingMode='metered', credentialKind='apiKey',baseUrl=f'http://127.0.0.1:{server.server_port}/v1'))),'--api-key-file',key)
        finally: key.unlink(missing_ok=True)
        configure('models','set','--input',save('model.json',dict(id='mac-qa',name='Mac QA',model='mac-qa',connectionId='mac-local',
            enabled=True,kind='responses',providerFlavor='openai',imageInput=visual,contextWindowTokens=200000,maxOutputTokens=2048)))
        for index in range(2):
            params = dict(text='Check only the fixture.',profileId='mac-qa', recipe=dict(productComponents=[],
                tools=dict(kernel=[],controls=[],plugins=True),permissions={'agent.permissions.external':'allow'}),
                pluginSelections=[dict(selectionId='fixture-desktop',uri='plugin://computer-use@builtin',label='Computer Use')]) if index==0 else dict(sessionId=sid,text='Review the previous results without new input.')
            frames = [json.loads(line) for line in debug('task','submit','--params','@'+str(save('request.json',params)), '--follow').splitlines() if line]
            sid = next(f['sessionId'] for f in frames if f.get('submission'))
            status = json.loads(debug('task','inspect','--session-id',sid))['run']
            assert status['status'] == 'completed' and not failed, (status, failed)
            report['runs'].append({'id':status['runId'],'status':status['status']})
        assert turn == len(expected)+2 and not failed
        db, = state.rglob('tool-record.sqlite3')
        with sqlite3.connect(db.as_uri()+'?mode=ro', uri=True) as conn:
            ids = conn.execute('SELECT record_id FROM tool_records WHERE session_id=? ORDER BY rowid',(sid,)).fetchall()
        records = [json.loads(debug('result','read','--record-id',rid)) for rid, in ids]
        report['tools'] = [(r['input']['action'], r['outcome']) for r in records if r['toolName']=='computer.control']
        assert report['tools'] == expected
        if visual:
            capture, = (r for r in records if r['toolName'] == 'computer.control' and r['input']['action'] == 'capture')
            raw, wire = capture['output'], report['singleImage']
            artifact, = raw['artifacts']
            assert raw['captureId'] == wire['captureId'] and artifact['artifactId'] == wire['artifactId']
            assert raw['contentRef'] == artifact['contentRef'] and raw['target'] == {'windowId': target['windowId']}
            png = Path(raw['contentRef']).resolve(strict=True)
            assert (state / 'data/agent-runtime/tool-record.outputs').resolve() in png.parents
            assert hashlib.sha256(png.read_bytes()).hexdigest() == wire['sha256'], 'Delivered PNG differs from this capture record'
            wire['marker'] = json.loads(subprocess.check_output([exe, '--marker', png], text=True))
            assert wire['marker']['red'] > 100, wire['marker']
        report['effects'] = json.loads((root / 'effects.json').read_bytes()); assert report['effects'] == {'enabled':1,'disabled':0}
        report['sessionId'] = sid
    except BaseException:
        failed.append(traceback.format_exc()); raise
    finally:
        try:
            if owned:
                stop = json.loads(debug('stop')); assert stop['cleanupComplete']
                assert json.loads(debug('instances'))['instances'] == []; report['hostStopped'] = True
        finally:
            server.shutdown(); server.server_close(); thread.join()
            (root / 'stop-window').touch()
            try: report['targetClosed'] = target_process.wait(timeout=5) == 0
            except subprocess.TimeoutExpired: target_process.terminate(); target_process.wait(timeout=5); report['targetClosed'] = False
            report['passed'] = not failed and report.get('hostStopped') and report['targetClosed']
            if failed: report['errors'] = failed
            save('report.json',report)
            print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    assert report['passed']

if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), *sys.argv[3:])
