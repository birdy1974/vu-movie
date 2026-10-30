import importlib.util
import json
import os
import sys
import tempfile
import time
import types
import unittest
import xml.etree.ElementTree as ET

class Timer:
    def __init__(self): self.callback = []
    def start(self, *args): pass
    def stop(self): pass

class Descriptor:
    WHERE_AUTOSTART = 1
    def __init__(self, **kwargs): self.kwargs = kwargs

sys.modules['enigma'] = types.SimpleNamespace(eTimer=Timer)
sys.modules['Plugins'] = types.ModuleType('Plugins')
sys.modules['Plugins.Plugin'] = types.SimpleNamespace(PluginDescriptor=Descriptor)
spec = importlib.util.spec_from_file_location('bridge', 'src/enigma2/receiver/plugin.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class Importer:
    def __init__(self): self.running = False; self.sources = []
    def isImportRunning(self): return self.running

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        for attr, filename in [('REQUEST','request.json'), ('DATA','data.json'), ('STATUS','status.json'), ('XML','epg.xml'), ('SOURCES','sources.xml')]:
            setattr(bridge, attr, os.path.join(self.tmp.name, filename))
        bridge.BOUQUET_DIR = self.tmp.name
        self.importer = Importer()
        setting = types.SimpleNamespace(value=False)
        self.plugin = types.SimpleNamespace(epgimport=self.importer, lastImportResult=None,
            config=types.SimpleNamespace(plugins=types.SimpleNamespace(epgimport=types.SimpleNamespace(clear_oldepg=setting))),
            EPGConfig=types.SimpleNamespace(channelCache={}, enumSourcesFile=lambda _: [types.SimpleNamespace(description=bridge.SOURCE)]))
        def start(): self.importer.running = True
        self.plugin.startImport = start
        sys.modules['Plugins.Extensions.EPGImport.plugin'] = self.plugin
        self.worker = bridge.Bridge()

    def tearDown(self):
        del sys.modules['Plugins.Extensions.EPGImport.plugin']
        self.tmp.cleanup()

    def publish(self, ident):
        ref = '5002:0:1:0001:0000:0000:0:0:0:0:http%3a//nas/movie:Movie'
        with open(os.path.join(self.tmp.name, 'userbouquet.vu-movie.tv'), 'w') as f: f.write('#SERVICE ' + ref + '\n')
        with open(bridge.DATA, 'w') as f: json.dump({'version':1,'requestId':ident,'bouquetFile':'userbouquet.vu-movie.tv','items':[{'id':'v1','ref':ref,'title':'Amélie & Co','plot':'Plot <ok>'}]}, f)
        with open(bridge.REQUEST, 'w') as f: json.dump({'id':ident}, f)

    def status(self): return bridge.read_json(bridge.STATUS)

    def test_request_busy_completion_and_new_request(self):
        self.publish('first')
        self.importer.running = True
        self.worker.tick()
        self.assertEqual(self.status()['state'], 'waiting')
        self.importer.running = False
        self.worker.tick()
        self.assertEqual(self.status()['state'], 'importing')
        self.assertTrue(self.importer.running)
        root = ET.parse(bridge.XML).getroot()
        self.assertEqual(root.find('programme/desc').text, 'Plot <ok>')
        self.publish('second')
        self.worker.tick()
        self.assertEqual(self.status()['requestId'], 'first')
        self.plugin.lastImportResult = (time.time(), 72)
        self.importer.running = False
        self.worker.tick()
        self.assertEqual(self.status()['requestId'], 'second')
        self.assertEqual(self.status()['state'], 'importing')
        self.plugin.lastImportResult = (time.time(), 72)
        self.importer.running = False
        self.worker.tick()
        self.assertEqual(self.status()['state'], 'finished')
        self.assertEqual(self.status()['events'], 72)
        self.worker.tick()
        self.assertFalse(self.importer.running)
        self.worker.completed_day -= 1
        self.worker.tick()
        self.assertTrue(self.importer.running, 'synthetic events are refreshed and reimported daily')

    def test_refuses_global_epg_flush(self):
        self.publish('danger')
        self.plugin.config.plugins.epgimport.clear_oldepg.value = True
        self.worker.tick()
        self.assertEqual(self.status()['state'], 'error')
        self.assertFalse(self.importer.running)
        self.plugin.config.plugins.epgimport.clear_oldepg.value = False
        self.worker.tick()
        self.assertEqual(self.status()['state'], 'importing')

    def test_other_bouquet_collision_blocks_import(self):
        self.publish('collision')
        with open(os.path.join(self.tmp.name, 'userbouquet.other.tv'), 'w') as f:
            f.write('#SERVICE 4097:0:1:0001:0000:0000:ABC:0:0:0:http%3a//other:Other\n')
        self.worker.tick()
        self.assertEqual(self.status()['state'], 'error')
        self.assertIn('another service', self.status()['message'])
        self.assertFalse(self.importer.running)

    def test_changed_bouquet_blocks_import(self):
        self.publish('stale')
        with open(os.path.join(self.tmp.name, 'userbouquet.vu-movie.tv'), 'w') as f: f.write('#NAME changed\n')
        self.worker.tick()
        self.assertEqual(self.status()['state'], 'error')
        self.assertIn('changed since', self.status()['message'])
        self.assertFalse(self.importer.running)

    def test_incomplete_data_waits(self):
        self.publish('one')
        with open(bridge.REQUEST, 'w') as f: json.dump({'id':'two'}, f)
        self.worker.tick()
        self.assertEqual(self.status()['state'], 'waiting')
        self.assertFalse(self.importer.running)

if __name__ == '__main__': unittest.main()
