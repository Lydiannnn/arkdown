import { EditorView as CodeView, keymap as cmKeymap } from '@codemirror/view'
import { EditorState as CodeState } from '@codemirror/state'
import { defaultKeymap, history as cmHistory, historyKeymap } from '@codemirror/commands'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState as ProseState, TextSelection } from '@milkdown/kit/prose/state'
import { EditorView as ProseView } from '@milkdown/kit/prose/view'
import { baseKeymap } from '@milkdown/kit/prose/commands'
import { keymap as pmKeymap } from '@milkdown/kit/prose/keymap'
import { history as pmHistory, undo, redo } from '@milkdown/kit/prose/history'
const sample = 'alpha beta gamma'
const text = document.querySelector<HTMLTextAreaElement>('#text')!
const cm = new CodeView({ parent: document.querySelector('#cm')!, state: CodeState.create({ doc: sample, extensions: [cmHistory(), cmKeymap.of([...historyKeymap, ...defaultKeymap])] }) })
const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', toDOM: () => ['p', 0] }, text: {} } })
const pm = new ProseView(document.querySelector('#pm')!, { state: ProseState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text(sample)])]), plugins: [pmHistory(), pmKeymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }), pmKeymap(baseKeymap)] }) })
const events: unknown[] = []
document.addEventListener('keydown', event => events.push({ key: event.key, trusted: event.isTrusted, repeat: event.repeat }))
Object.assign(window, { fixture: {
  reset(kind: string) {
    if (kind === 'text') { text.value = sample; text.focus(); text.setSelectionRange(sample.length, sample.length) }
    if (kind === 'cm') { cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: sample }, selection: { anchor: sample.length } }); cm.focus() }
    if (kind === 'pm') { pm.updateState(ProseState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text(sample)])]), plugins: [pmHistory(), pmKeymap({ 'Mod-z': undo, 'Mod-y': redo }), pmKeymap(baseKeymap)] })); pm.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, sample.length + 1))); pm.focus() }
    events.length = 0
  },
  read(kind: string) {
    if (kind === 'text') return { text: text.value, anchor: text.selectionStart, head: text.selectionEnd, events }
    if (kind === 'cm') return { text: cm.state.doc.toString(), anchor: cm.state.selection.main.from, head: cm.state.selection.main.to, events }
    return { text: pm.state.doc.textContent, anchor: pm.state.selection.from - 1, head: pm.state.selection.to - 1, events }
  },
} })
