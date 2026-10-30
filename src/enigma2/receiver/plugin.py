# vu-movie OpenPLi EPGImport bridge. No network listener or shell commands.
# Installed once by vu-movie; Enigma2 GUI restart loads the autostart hook.
from __future__ import absolute_import, print_function, unicode_literals
import json
import io
import os
import sys
import time
from xml.sax.saxutils import escape, quoteattr
from enigma import eTimer
from Plugins.Plugin import PluginDescriptor

DIR = '/etc/epgimport'
SOURCE = 'vu-movie plot information'
REQUEST = os.path.join(DIR, 'vumovie.request.json')
DATA = os.path.join(DIR, 'vumovie.json')
# Heartbeats live in RAM-backed /tmp, not the receiver's flash storage.
STATUS = '/tmp/vumovie-epg.status.json'
XML = os.path.join(DIR, 'vumovie.xml')
SOURCES = os.path.join(DIR, 'vumovie.sources.xml')
BOUQUET_DIR = '/etc/enigma2'


def read_json(path):
    with io.open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def atomic_write(path, content):
    temp = path + '.helper.tmp'
    with io.open(temp, 'w', encoding='utf-8') as handle:
        try:
            text = unicode(content)
        except NameError:
            text = str(content)
        handle.write(text)
    os.rename(temp, path)


def refresh_xml(data, now):
    # Keep EPGImport's scheduled source usable even weeks after the last push.
    # XML is atomically replaced, never edited while an import is reading it.
    day = int(now // 86400) * 86400
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="vu-movie">']
    for item in data['items']:
        ident = quoteattr(item['id'])
        title = escape(item['title'])
        plot = escape(item['plot'])
        lines.append('<channel id=%s><display-name>%s</display-name></channel>' % (ident, title))
        for stamp in range(day - 86400, day + 8 * 86400, 6 * 3600):
            start = time.strftime('%Y%m%d%H%M%S +0000', time.gmtime(stamp))
            end = time.strftime('%Y%m%d%H%M%S +0000', time.gmtime(stamp + 6 * 3600))
            lines.append('<programme channel=%s start=%s stop=%s><title>%s</title><desc>%s</desc></programme>' % (ident, quoteattr(start), quoteattr(end), title, plot))
    lines.append('</tv>')
    atomic_write(XML, '\n'.join(lines) + '\n')


def epg_identity(ref):
    parts = ref.split(':')
    if len(parts) < 10 or parts[1] == '7':
        return None
    try:
        return tuple(int(value, 16) for value in parts[3:6])
    except ValueError:
        return None


def validate_bouquets(data):
    # OpenPLi keys EPG by SID/TSID/ONID, ignoring type, namespace and URL.
    # Re-check before every import: another bouquet may have changed since push.
    name = data.get('bouquetFile', '')
    if not name.startswith('userbouquet.') or '/' in name or not name.endswith('.tv'):
        raise RuntimeError('Invalid vu-movie bouquet name in EPG data.')
    own = dict((epg_identity(item['ref']), item['ref']) for item in data['items'])
    if None in own or len(own) != len(data['items']):
        raise RuntimeError('Duplicate or invalid vu-movie EPG identities.')
    found = False
    for filename in os.listdir(BOUQUET_DIR):
        if not filename.startswith('userbouquet.') or not filename.endswith(('.tv', '.radio')):
            continue
        with io.open(os.path.join(BOUQUET_DIR, filename), 'r', encoding='utf-8') as handle:
            refs = [line.strip()[9:] for line in handle if line.startswith('#SERVICE ')]
        if filename == name:
            found = True
            actual = [ref for ref in refs if epg_identity(ref) is not None]
            if actual != [item['ref'] for item in data['items']]:
                raise RuntimeError('The vu-movie bouquet changed since the EPG push; push the playlist again.')
            continue
        for ref in refs:
            key = epg_identity(ref)
            if key not in own:
                continue
            other_parts = ref.split(':')
            own_parts = own[key].split(':')
            if len(other_parts) > 10 and len(own_parts) > 10 and other_parts[10] and other_parts[10] == own_parts[10]:
                continue
            raise RuntimeError('EPG identity also used by %s; refusing to replace another service EPG.' % filename)
    if not found:
        raise RuntimeError('The vu-movie bouquet is missing; push the playlist again.')


class Bridge(object):
    def __init__(self):
        self.active = None
        self.completed = None
        self.day = None
        self.completed_day = None
        self.active_started = 0
        self.last_error = None
        try:
            old = read_json(STATUS)
            if old.get('state') in ('finished', 'error') and old.get('importDay') is not None:
                self.completed = old.get('requestId')
                self.completed_day = old.get('importDay')
        except Exception:
            pass
        self.timer = eTimer()
        try:
            self.timer.callback.append(self.tick)
        except AttributeError:
            self.timer.timeout.get().append(self.tick)
        self.timer.start(5000, False)
        self.tick()

    def report(self, request_id, state, message, count=None):
        result = {'requestId': request_id, 'state': state, 'message': message, 'heartbeat': int(time.time() * 1000)}
        if self.completed_day is not None and request_id == self.completed:
            result['importDay'] = self.completed_day
        if count is not None:
            result['events'] = count
        atomic_write(STATUS, json.dumps(result))

    def tick(self):
        try:
            self.run()
            self.last_error = None
        except Exception as error:
            self.active = None
            if str(error) != self.last_error:
                print('[vu-movie EPG] helper error: %s' % error)
                self.last_error = str(error)
            try:
                request = read_json(REQUEST)
                self.report(request.get('id', ''), 'error', str(error))
            except Exception:
                pass

    def run(self):
        if not os.path.exists(REQUEST):
            return
        request = read_json(REQUEST)
        request_id = request.get('id')
        if not request_id:
            return
        plugin = sys.modules.get('Plugins.Extensions.EPGImport.plugin')
        if plugin is None:
            self.report(request_id, 'error', 'EPGImport is not loaded. Install EPGImport and restart the Enigma2 GUI.')
            return
        importer = plugin.epgimport
        if self.active:
            if importer.isImportRunning():
                self.report(self.active, 'importing', 'EPGImport is running.')
                return
            result = plugin.lastImportResult
            count = result[1] if result and result[0] >= self.active_started else 0
            self.completed = self.active
            self.completed_day = int(time.time() // 86400)
            self.report(self.active, 'finished' if count else 'error', 'EPGImport finished; check the receiver EPG. Event count does not verify each mapping.' if count else 'EPGImport processed no events; check EPGImport logs and service mappings.', count)
            self.active = None
        data = read_json(DATA)
        if data.get('version') != 1:
            raise RuntimeError('Unsupported vu-movie EPG data version; update the receiver helper and restart Enigma2.')
        if data.get('requestId') != request_id:
            self.report(request_id, 'waiting', 'Waiting for a complete EPG data set.')
            return
        day = int(time.time() // 86400)
        if self.day != day:
            refresh_xml(data, time.time())
            self.day = day
        if self.completed == request_id and self.completed_day == day:
            # Keep heartbeat alive so the sender can distinguish a live helper.
            current = read_json(STATUS)
            self.report(request_id, current.get('state', 'finished'), current.get('message', ''), current.get('events'))
            return
        if importer.isImportRunning():
            self.report(request_id, 'waiting', 'Another EPG import is running; waiting to import vu-movie.')
            return
        # The user's global setting can flush ALL broadcast EPG. Never trigger it.
        clear_setting = getattr(plugin.config.plugins.epgimport, 'clear_oldepg', None)
        if clear_setting is not None and clear_setting.value:
            self.report(request_id, 'error', 'Disable EPGImport "clear old EPG before import" before automatic import; this protects your other EPG data.')
            return
        validate_bouquets(data)
        plugin.EPGConfig.channelCache = {}
        sources = [source for source in plugin.EPGConfig.enumSourcesFile(SOURCES) if source.description == SOURCE]
        if len(sources) != 1:
            raise RuntimeError('The vu-movie EPGImport source could not be loaded.')
        importer.sources = sources
        self.active = request_id
        self.active_started = time.time()
        self.report(request_id, 'importing', 'Starting EPGImport for vu-movie.')
        plugin.startImport()
        # Some versions finish immediately on error or empty inputs.
        if not importer.isImportRunning():
            result = plugin.lastImportResult
            count = result[1] if result and result[0] >= self.active_started else 0
            self.completed = request_id
            self.completed_day = int(time.time() // 86400)
            self.active = None
            self.report(request_id, 'finished' if count else 'error', 'EPGImport finished; check the receiver EPG. Event count does not verify each mapping.' if count else 'EPGImport processed no events; check EPGImport logs and service mappings.', count)


bridge = None


def autostart(reason, **kwargs):
    global bridge
    if reason == 0 and bridge is None:
        bridge = Bridge()
    elif reason != 0 and bridge is not None:
        bridge.timer.stop()
        bridge = None


def Plugins(**kwargs):
    return [PluginDescriptor(where=PluginDescriptor.WHERE_AUTOSTART, fnc=autostart)]
