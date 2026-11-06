// The picture vocabulary. Adding a language means adding one key to each entry and to STRINGS.
// Emoji are a stand-in: the real set should be drawn and tested with the crew (see RESEARCH.md).

export const ACTIONS = {
  harvest: { icon: '🧺', en: 'Harvest', es: 'Cosechar' },
  water: { icon: '💧', en: 'Water', es: 'Regar' },
  weed: { icon: '🌿', en: 'Pull weeds', es: 'Quitar hierba' },
  plant: { icon: '🌱', en: 'Plant', es: 'Sembrar' },
  prune: { icon: '✂️', en: 'Prune', es: 'Podar' },
  load: { icon: '📦', en: 'Load', es: 'Cargar' },
  clean: { icon: '🧹', en: 'Clean', es: 'Limpiar' },
  fix: { icon: '🔧', en: 'Fix', es: 'Arreglar' },
  drive: { icon: '🚜', en: 'Drive', es: 'Manejar' },
};

export const THINGS = {
  strawberry: { icon: '🍓', en: 'strawberries', es: 'fresas' },
  lettuce: { icon: '🥬', en: 'lettuce', es: 'lechuga' },
  tomato: { icon: '🍅', en: 'tomatoes', es: 'tomates' },
  broccoli: { icon: '🥦', en: 'broccoli', es: 'brócoli' },
  bins: { icon: '🪣', en: 'bins', es: 'cajas' },
  pipe: { icon: '🚰', en: 'water line', es: 'tubería' },
  fence: { icon: '🚧', en: 'fence', es: 'cerca' },
  tractor: { icon: '🚜', en: 'tractor', es: 'tractor' },
};

// Things a worker can send up to the supervisor.
export const REQUESTS = {
  broken: { icon: '🔧', en: 'Something is broken', es: 'Algo está roto' },
  supplies: { icon: '📦', en: 'Need supplies', es: 'Faltan materiales' },
  need_water: { icon: '🥤', en: 'No drinking water', es: 'No hay agua para tomar' },
  leak: { icon: '💦', en: 'Water leak', es: 'Fuga de agua' },
  pests: { icon: '🐛', en: 'Pests on crop', es: 'Plaga en la planta' },
  injury: { icon: '🚑', en: 'Someone is hurt', es: 'Alguien está herido' },
  help: { icon: '🙋', en: 'Need help', es: 'Necesito ayuda' },
  done_all: { icon: '✅', en: 'All tasks done', es: 'Terminé todo' },
};

export const PROBLEMS = {
  broken: { icon: '🔧', en: 'Broken', es: 'Roto' },
  supplies: { icon: '📦', en: 'No supplies', es: 'Sin materiales' },
  help: { icon: '🙋', en: 'Need help', es: 'Necesito ayuda' },
  unsafe: { icon: '⚠️', en: 'Not safe', es: 'Peligroso' },
  weather: { icon: '🌧️', en: 'Bad weather', es: 'Mal tiempo' },
};

export const STRINGS = {
  en: {
    who: 'Who are you?', start: 'Start work', stop: 'Stop work', break: 'Break', backToWork: 'Back to work',
    tasks: 'My work', noTasks: 'No work yet', sentToBoss: 'Sent to boss', doneToday: 'Done today',
    begin: 'Start', done: 'Done', problem: 'Problem', cancel: 'Back', send: 'Send',
    photo: 'Photo', voice: 'Voice', write: 'Write', scan: 'Scan tag', ask: 'Tell boss',
    started: 'Work started', stopped: 'Work stopped', onBreak: 'Break started', resumed: 'Back to work',
    sent: 'Sent', saved: 'Saved', waiting: 'Saved, will send when there is signal', recording: 'Recording. Tap to stop.',
    tapRecord: 'Tap to record', worked: 'Today', noEntry: 'Do not enter', noEntryLong: 'Stop. Do not go in this field. Leave now.',
    openUntil: 'Open at', leave: 'I am leaving', take: 'Take', giveBack: 'Give back', taken: 'You have this', heldBy: 'With',
    here: 'You are here', noted: 'Location saved', unknownTag: 'New tag. Boss will set it up.', tapTag: 'Hold phone to tag',
    consentTitle: 'Your location', consentSay: 'The farm sees where you are only while you are at work. When you stop work, it stops. Is this OK?',
    yes: 'Yes', no: 'No', simTags: 'Test tags', typeNote: 'Write here', workerSwitch: 'Change person',
    noVoice: 'Microphone is not available', noCamera: 'Camera is not available',
    speakTask: (action, thing, zone, qty) => [action, qty ? `${qty}` : '', thing, zone ? `in ${zone}` : ''].filter(Boolean).join(' '),
  },
  es: {
    who: '¿Quién eres?', start: 'Empezar trabajo', stop: 'Terminar trabajo', break: 'Descanso', backToWork: 'Volver al trabajo',
    tasks: 'Mi trabajo', noTasks: 'Sin trabajo por ahora', sentToBoss: 'Enviado al jefe', doneToday: 'Hecho hoy',
    begin: 'Empezar', done: 'Listo', problem: 'Problema', cancel: 'Atrás', send: 'Enviar',
    photo: 'Foto', voice: 'Voz', write: 'Escribir', scan: 'Leer etiqueta', ask: 'Avisar al jefe',
    started: 'Trabajo empezado', stopped: 'Trabajo terminado', onBreak: 'Descanso empezado', resumed: 'De vuelta al trabajo',
    sent: 'Enviado', saved: 'Guardado', waiting: 'Guardado, se enviará cuando haya señal', recording: 'Grabando. Toca para parar.',
    tapRecord: 'Toca para grabar', worked: 'Hoy', noEntry: 'No entrar', noEntryLong: 'Alto. No entres a este campo. Sal ahora.',
    openUntil: 'Abre a las', leave: 'Ya me voy', take: 'Tomar', giveBack: 'Devolver', taken: 'Lo tienes tú', heldBy: 'Con',
    here: 'Estás aquí', noted: 'Ubicación guardada', unknownTag: 'Etiqueta nueva. El jefe la configurará.', tapTag: 'Acerca el teléfono a la etiqueta',
    consentTitle: 'Tu ubicación', consentSay: 'La granja ve dónde estás solo mientras trabajas. Cuando terminas, se detiene. ¿Está bien?',
    yes: 'Sí', no: 'No', simTags: 'Etiquetas de prueba', typeNote: 'Escribe aquí', workerSwitch: 'Cambiar persona',
    noVoice: 'El micrófono no está disponible', noCamera: 'La cámara no está disponible',
    speakTask: (action, thing, zone, qty) => [action, qty ? `${qty}` : '', thing, zone ? `en ${zone}` : ''].filter(Boolean).join(' '),
  },
};
