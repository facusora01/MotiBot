const https = require("https");

const SOURCES = [
  { id: 'LOCAL', lang: 'es' },
  { id: 'GITHUB_ES', url: "https://raw.githubusercontent.com/skatox/frases-famosas-latinoamerica/master/frases.json", lang: 'es' },
  { id: 'ZENQUOTES', url: "https://zenquotes.io/api/random", lang: 'en' },
  { id: 'QUOTABLE', url: "https://api.quotable.io/random", lang: 'en' },
  { id: 'THEYSAIDSO', url: "https://quotes.rest/qod", lang: 'en' },
  { id: 'NINJAS', url: "https://api.api-ninjas.com/v1/quotes?category=inspirational", lang: 'en' },
  { id: 'FAVQS', url: "https://favqs.com/api/qotd", lang: 'en' }
];

async function translateTo(text, lang) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    // MYMEMORY_EMAIL opcional: sube la cuota diaria de traducción ante MyMemory.
    const de = process.env.MYMEMORY_EMAIL ? `&de=${encodeURIComponent(process.env.MYMEMORY_EMAIL)}` : "";
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|es${de}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return text;
    const data = await res.json();
    return data.responseData?.translatedText || text;
  } catch (e) {
    clearTimeout(timeout);
    return text;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function standardize(data, sourceId) {
  switch (sourceId) {
    case 'ZENQUOTES': return { texto: data[0].q, autor: data[0].a };
    case 'QUOTABLE': return { texto: data.content, autor: data.author };
    case 'THEYSAIDSO': return { texto: data.contents.quotes[0].quote, autor: data.contents.quotes[0].author };
    case 'NINJAS': return { texto: data[0].quote, autor: data[0].author };
    case 'FAVQS': return { texto: data.quote.body, autor: data.quote.author };
    case 'GITHUB_ES': 
      const item = data[Math.floor(Math.random() * data.length)];
      return { texto: item.frase || item.texto, autor: item.autor || "Anónimo" };
    default: return null;
  }
}

async function getPhrase(targetLang = "es") {
  const source = SOURCES[Math.floor(Math.random() * SOURCES.length)];
  if (source.id === 'LOCAL') return getRandomSpanishPhrase();

  try {
    const headers = {};
    // NINJAS requiere API key; sin ella falla y cae al catch.
    if (source.id === 'NINJAS') headers['X-Api-Key'] = process.env.NINJAS_API_KEY;

    const res = await fetchWithTimeout(source.url, { headers }, 4000);
    if (!res.ok) throw new Error("API Offline");

    const rawData = await res.json();

    if (rawData.error || rawData.message === "Not authenticated") {
      console.log(`⚠️ API ${source.id} denegó el acceso. Aplicando 'Jump' a local...`);
      return getRandomSpanishPhrase();
    }

    const phrase = standardize(rawData, source.id);

    if (phrase && source.lang !== targetLang) {
      phrase.texto = await translateTo(phrase.texto, targetLang);
    }

    return phrase || getRandomSpanishPhrase();
  } catch (error) {
    return getRandomSpanishPhrase(); // el "Jump": cualquier falla cae a una frase local
  }
}

// Pool pre-cargado por idioma: las APIs remotas tardan (fetch + traducción) y
// demoraban el reply de /mbot phrase. Custom no va acá: ya es instantáneo por
// SQLite, y un pool le rompería la frescura.
const POOL_MAX = 20;
const POOL_MIN = 5;
const pools = { es: [], en: [] };
const rellenando = { es: false, en: false };

async function fetchRemota(targetLang) {
  // translateTo solo traduce en→es, así que para 'en' evitamos fuentes 'es'.
  let candidatas = SOURCES.filter((s) => s.id !== "LOCAL");
  if (targetLang === "en") candidatas = candidatas.filter((s) => s.lang === "en");
  if (!candidatas.length) return null;

  const source = candidatas[Math.floor(Math.random() * candidatas.length)];
  try {
    const headers = {};
    if (source.id === "NINJAS") headers["X-Api-Key"] = process.env.NINJAS_API_KEY;

    const res = await fetchWithTimeout(source.url, { headers }, 4000);
    if (!res.ok) return null;

    const rawData = await res.json();
    if (rawData.error || rawData.message === "Not authenticated") return null;

    const phrase = standardize(rawData, source.id);
    if (!phrase || !phrase.texto) return null;

    if (source.lang !== targetLang) {
      phrase.texto = await translateTo(phrase.texto, targetLang);
    }
    return phrase;
  } catch (e) {
    return null;
  }
}

async function rellenarPool(lang) {
  const l = lang === "en" ? "en" : "es";
  if (rellenando[l]) return;
  rellenando[l] = true;
  try {
    let intentos = 0;
    while (pools[l].length < POOL_MAX && intentos < POOL_MAX * 2) {
      intentos++;
      const f = await fetchRemota(l);
      if (f) pools[l].push(f);
    }
  } finally {
    rellenando[l] = false;
  }
}

function getPhraseInstant(lang = "es") {
  const l = lang === "en" ? "en" : "es";
  const frase = pools[l].shift();
  if (pools[l].length < POOL_MIN) rellenarPool(l); // sin await: fire-and-forget
  return frase || getRandomSpanishPhrase();
}

let poolIniciado = false; // el setInterval se arma una sola vez pese a reintentos de 'ready'
function iniciarPool() {
  rellenarPool("es");
  rellenarPool("en");
  if (poolIniciado) return;
  poolIniciado = true;
  setInterval(() => {
    rellenarPool("es");
    rellenarPool("en");
  }, 10 * 60 * 1000).unref(); // unref: no bloquea el cierre del proceso
}

const frasesES = [
    { texto: "El éxito no es la clave de la felicidad. La felicidad es la clave del éxito.", autor: "Albert Schweitzer" },
  { texto: "No cuentes los días, haz que los días cuenten.", autor: "Muhammad Ali" },
  { texto: "El único modo de hacer un gran trabajo es amar lo que hacés.", autor: "Steve Jobs" },
  { texto: "Primero te ignoran, después se ríen de vos, luego te atacan. Entonces ganás.", autor: "Mahatma Gandhi" },
  { texto: "El futuro pertenece a quienes creen en la belleza de sus sueños.", autor: "Eleanor Roosevelt" },
  { texto: "No importa lo lento que vayas, siempre y cuando no te detengas.", autor: "Confucio" },
  { texto: "La vida es lo que pasa mientras estás ocupado haciendo otros planes.", autor: "John Lennon" },
  { texto: "Sé el cambio que querés ver en el mundo.", autor: "Mahatma Gandhi" },
  { texto: "Somos lo que hacemos repetidamente. La excelencia no es un acto sino un hábito.", autor: "Aristóteles" },
  { texto: "Cada día es una nueva oportunidad para cambiar tu vida.", autor: "Anónimo" },
  { texto: "El dolor es temporal, el orgullo es para siempre.", autor: "Anónimo" },
  { texto: "No tengas miedo de ser grande. Sé lo que naciste para ser.", autor: "Anónimo" },
  { texto: "Cae siete veces, levántate ocho.", autor: "Proverbio japonés" },
  { texto: "La diferencia entre lo posible y lo imposible está en la determinación.", autor: "Tommy Lasorda" },
  { texto: "Creé en vos mismo y todo lo demás encajará.", autor: "Anónimo" },
  { texto: "Lo que no te mata te hace más fuerte.", autor: "Friedrich Nietzsche" },
  { texto: "El camino de mil millas comienza con un solo paso.", autor: "Lao Tzu" },
  { texto: "Si podés soñarlo, podés lograrlo.", autor: "Walt Disney" },
  { texto: "La perseverancia es el trabajo duro que hacés después de cansarte del trabajo duro que ya hiciste.", autor: "Newt Gingrich" },
  { texto: "Tu tiempo es limitado, no lo desperdicies viviendo la vida de otra persona.", autor: "Steve Jobs" },
  { texto: "Hace lo que podés, con lo que tenés, donde estás.", autor: "Theodore Roosevelt" },
  { texto: "El éxito es la suma de pequeños esfuerzos repetidos día tras día.", autor: "Robert Collier" },
  { texto: "Quien tiene un porqué para vivir puede soportar casi cualquier cómo.", autor: "Friedrich Nietzsche" },
  { texto: "La vida no es fácil para ninguno de nosotros. Hay que tener perseverancia.", autor: "Marie Curie" },
  { texto: "No te rindas. El principio siempre es lo más difícil.", autor: "Anónimo" },
  { texto: "Un sueño no se hace realidad a través de la magia; requiere sudor, determinación y trabajo duro.", autor: "Colin Powell" },
  { texto: "Empezá donde estás. Usá lo que tenés. Hacé lo que podés.", autor: "Arthur Ashe" },
  { texto: "Los obstáculos son esas cosas espantosas que ves cuando apartás los ojos de tu meta.", autor: "Henry Ford" },
  { texto: "La única forma de hacer un trabajo brillante es amar lo que hacés.", autor: "Steve Jobs" },
  { texto: "La felicidad no es algo ya hecho. Viene de tus propias acciones.", autor: "Dalai Lama" },
  { texto: "En el medio de la dificultad reside la oportunidad.", autor: "Albert Einstein" },
  { texto: "La imaginación es más importante que el conocimiento.", autor: "Albert Einstein" },
  { texto: "No podés volver atrás y cambiar el principio, pero podés comenzar donde estás y cambiar el final.", autor: "C.S. Lewis" },
  { texto: "El mejor momento para plantar un árbol fue hace 20 años. El segundo mejor momento es ahora.", autor: "Proverbio chino" },
  { texto: "No es que sea tan inteligente, es que me quedo más tiempo con los problemas.", autor: "Albert Einstein" },
  { texto: "La vida es corta, y es ahora o nunca.", autor: "Anónimo" },
  { texto: "El secreto para salir adelante es empezar.", autor: "Mark Twain" },
  { texto: "No hay nada imposible para una mente dispuesta.", autor: "Alejandro Magno" },
  { texto: "Cuando todo parezca ir en tu contra, recordá que el avión despega contra el viento.", autor: "Henry Ford" },
  { texto: "La motivación es lo que te pone en marcha. El hábito es lo que te mantiene.", autor: "Jim Ryun" },
  { texto: "Siempre parece imposible hasta que se hace.", autor: "Nelson Mandela" },
  { texto: "El éxito generalmente llega a quienes están demasiado ocupados para buscarlo.", autor: "Henry David Thoreau" },
  { texto: "No te preocupes por los fracasos, preocupate por las chances que perdés cuando ni siquiera intentás.", autor: "Jack Canfield" },
  { texto: "Yo no fallé. Solo encontré 10,000 formas que no funcionan.", autor: "Thomas Edison" },
  { texto: "Si querés vivir una vida feliz, atala a una meta, no a personas ni objetos.", autor: "Albert Einstein" },
  { texto: "Nunca es tarde para ser lo que podrías haber sido.", autor: "George Eliot" },
  { texto: "La gente que está lo suficientemente loca como para pensar que puede cambiar el mundo, es la que lo hace.", autor: "Steve Jobs" },
  { texto: "Todo lo que necesitás para empezar a mejorar ya lo tenés.", autor: "Anónimo" },
  { texto: "El optimismo es la fe que conduce al logro.", autor: "Helen Keller" },
  { texto: "Actuá como si lo que hacés marcara la diferencia. Lo marca.", autor: "William James" },
  { texto: "El único límite a nuestros logros de mañana son nuestras dudas de hoy.", autor: "Franklin D. Roosevelt" },
  { texto: "La fortaleza no viene de ganar. Tus luchas desarrollan tu fortaleza.", autor: "Arnold Schwarzenegger" },
  { texto: "Podés enfrentarte a muchos fracasos en la vida, pero nunca dejes que te derroten.", autor: "Maya Angelou" },
  { texto: "No tengas miedo del fracaso. Tenés miedo de no intentarlo.", autor: "Roy T. Bennett" },
  { texto: "Lo mejor y más hermoso de este mundo no puede verse ni tocarse; debe sentirse con el corazón.", autor: "Helen Keller" },
  { texto: "Creer en uno mismo es el primer secreto del éxito.", autor: "Ralph Waldo Emerson" },
  { texto: "Primero tomá la decisión de que vas a llegar. Después hacé lo que sea necesario.", autor: "Anónimo" },
  { texto: "La vida se contrae o se expande en proporción al coraje de cada uno.", autor: "Anaïs Nin" },
  { texto: "La grandeza no es una función de la circunstancia. Es una elección.", autor: "Jim Collins" },
  { texto: "El único modo de descubrir los límites de lo posible es ir más allá, hacia lo imposible.", autor: "Arthur C. Clarke" },
  { texto: "Vivís solo una vez, pero si lo hacés bien, una vez es suficiente.", autor: "Mae West" },
  { texto: "Lo que sea que la mente puede concebir y creer, lo puede lograr.", autor: "Napoleon Hill" },
  { texto: "La confianza en uno mismo es el primer requisito para las grandes empresas.", autor: "Samuel Johnson" },
  { texto: "Cuanto más trabajo, más suerte tengo.", autor: "Gary Player" },
  { texto: "El camino al éxito y el camino al fracaso son casi exactamente el mismo.", autor: "Colin R. Davis" },
  { texto: "Soñá en grande y atrevete a fallar.", autor: "Norman Vaughan" },
  { texto: "La acción es la llave fundamental de todo éxito.", autor: "Pablo Picasso" },
  { texto: "El modo de dar es tan valioso como lo que se da.", autor: "Pierre Corneille" },
  { texto: "No esperes. El tiempo nunca será el exactamente correcto.", autor: "Napoleon Hill" },
  { texto: "Tu actitud, no tu aptitud, determina tu altitud.", autor: "Zig Ziglar" },
  { texto: "El éxito no es definitivo, el fracaso no es fatal: lo que cuenta es el coraje para continuar.", autor: "Winston Churchill" },
  { texto: "Sería maravilloso si pudiéramos hacer lo que queremos con lo que tenemos.", autor: "Anónimo" },
  { texto: "La única manera de hacer grandes cosas es amando lo que hacés.", autor: "Steve Jobs" },
  { texto: "Nunca desistas de un sueño solo por el tiempo que tomará alcanzarlo. El tiempo pasará de todas formas.", autor: "Earl Nightingale" },
  { texto: "No es quien eres por dentro lo que te define, sino lo que hacés.", autor: "Batman Begins" },
  { texto: "Sé fuerte cuando estés débil, valiente cuando estés asustado y humilde cuando estés victorioso.", autor: "Anónimo" },
  { texto: "No midas tu riqueza por el dinero que tenés, sino por la diferencia que hacés.", autor: "Anónimo" },
  { texto: "Cada logro grande alguna vez fue imposible.", autor: "Anónimo" },
  { texto: "La vida no se mide por las veces que respirás, sino por los momentos que te quitan el aliento.", autor: "Maya Angelou" },
  { texto: "Todo el mundo tiene talento, pero la habilidad requiere trabajo duro.", autor: "Michelangelo" },
  { texto: "Empezar es el trabajo más duro de todos.", autor: "Anónimo" },
  { texto: "Hacé hoy lo que otros no quieren hacer, mañana tendrás lo que otros no podrán tener.", autor: "Anónimo" },
  { texto: "No te rindas, generalmente el último intento es el que funciona.", autor: "Anónimo" },
  { texto: "La diferencia entre quién sos y quién querés ser está en lo que hacés.", autor: "Anónimo" },
  { texto: "El fracaso es el condimento que le da sabor al éxito.", autor: "Truman Capote" },
  { texto: "Nunca te arrepentirás de haber sido bueno.", autor: "Anónimo" },
  { texto: "Cuando hay voluntad, hay un camino.", autor: "Proverbio inglés" },
  { texto: "No mirés el reloj. Hacé lo mismo que él: seguí adelante.", autor: "Sam Levenson" },
  { texto: "La perseverancia no es una carrera larga; son muchas carreras cortas una tras otra.", autor: "Walter Elliot" },
  { texto: "Convertí cada obstáculo en una oportunidad.", autor: "Anónimo" },
  { texto: "La vida es demasiado importante para tomársela en serio.", autor: "Oscar Wilde" },
  { texto: "Cada día trae nuevas elecciones.", autor: "Martha Beck" },
  { texto: "El entusiasmo es la electricidad de la vida.", autor: "Gordon Parks" },
  { texto: "Si no construís tus sueños, alguien te va a contratar para construir los suyos.", autor: "Dhirubhai Ambani" },
  { texto: "No podés conectar los puntos mirando hacia adelante; solo podés conectarlos mirando hacia atrás.", autor: "Steve Jobs" },
  { texto: "Preferí hacer algo imperfecto a no hacer nada a la perfección.", autor: "Robert Schuller" },
  { texto: "La diferencia entre lo ordinario y lo extraordinario es ese pequeño extra.", autor: "Jimmy Johnson" },
  { texto: "Si querés resultados extraordinarios, dejá de tener comportamientos ordinarios.", autor: "Anónimo" },
  { texto: "El talento gana juegos, pero el trabajo en equipo y la inteligencia ganan campeonatos.", autor: "Michael Jordan" },
  { texto: "Limitá tus siempres y tus jamás.", autor: "Amy Poehler" },
  { texto: "El éxito es caminar de fracaso en fracaso sin perder el entusiasmo.", autor: "Winston Churchill" },
  { texto: "Cuanto más duro entrenás, más difícil es rendirse.", autor: "Vince Lombardi" },
  { texto: "El trabajo duro vence al talento cuando el talento no trabaja duro.", autor: "Tim Notke" },
  { texto: "Los ganadores no se rinden; los que se rinden no ganan.", autor: "Vince Lombardi" },
  { texto: "Creé con toda tu alma en lo que hacés.", autor: "Carl Sandburg" },
  { texto: "No hay atajos a ningún lugar que valga la pena ir.", autor: "Beverly Sills" },
  { texto: "La oportunidad no sucede, la creás.", autor: "Chris Grosser" },
  { texto: "El éxito es limonada: necesitás limones y que sepas hacerla.", autor: "Anónimo" },
  { texto: "Tu peor enemigo no puede hacerte tanto daño como tus propios pensamientos sin guardar.", autor: "Buda" },
  { texto: "Una pequeña chispa positiva puede quemar mil momentos negativos.", autor: "Anónimo" },
  { texto: "Hacé primero las cosas difíciles. Lo fácil se cuida solo.", autor: "Dale Carnegie" },
  { texto: "La adversidad revela el genio; la prosperidad lo oculta.", autor: "Horacio" },
  { texto: "Levantate. Sacudite el polvo. Seguí adelante.", autor: "Anónimo" },
  { texto: "La vida no te da lo que pedís, sino lo que exigís.", autor: "Anónimo" },
  { texto: "El mejor proyecto en el que podés trabajar sos vos mismo.", autor: "Anónimo" },
  { texto: "No esperes a que llegue la inspiración. Salí a buscarla.", autor: "Jack London" },
  { texto: "Cada mañana nos nacemos de nuevo. Lo que hacemos hoy es lo que más importa.", autor: "Buda" },
  { texto: "Si no te gusta algo, cambialo. Si no podés cambiarlo, cambiá tu actitud.", autor: "Maya Angelou" },
  { texto: "Hacete cargo de tu vida. Nadie más lo va a hacer.", autor: "Anónimo" },
  { texto: "Un guerrero elige su batalla, pero cuando la elige, la da entera.", autor: "Anónimo" },
  { texto: "La constancia es la virtud de los que no tienen mucho talento.", autor: "Charles Bukowski" },
  { texto: "No hay viento favorable para quien no sabe adónde va.", autor: "Séneca" },
  { texto: "Nadie puede hacerte sentir inferior sin tu consentimiento.", autor: "Eleanor Roosevelt" },
  { texto: "La única fuente de conocimiento es la experiencia.", autor: "Albert Einstein" },
  { texto: "Nuestras vidas mejoran cuando tomamos riesgos y el primer y más difícil riesgo es ser honesto con uno mismo.", autor: "Walter Anderson" },
  { texto: "Las personas que son lo suficientemente locas para pensar que pueden cambiar el mundo, lo hacen.", autor: "Steve Jobs" },
  { texto: "Si no te arriesgás, no crecés. Si no crecés, no vivís realmente.", autor: "Anónimo" },
  { texto: "Uno puede ser más de lo que cree posible.", autor: "Anónimo" },
  { texto: "Lo que define a una persona es lo que hace con el poder que tiene.", autor: "Dumbledore" },
  { texto: "Recordá por qué empezaste.", autor: "Anónimo" },
  { texto: "Los que dicen que algo es imposible no deberían interrumpir a quienes lo están haciendo.", autor: "Albert Einstein" },
  { texto: "Cada versión de vos tiene que morir para que nazca la siguiente.", autor: "Anónimo" },
  { texto: "La excelencia no es un don sino una habilidad que se entrena.", autor: "Platón" },
  { texto: "Con suficiente motivación, cualquier obstáculo puede superarse.", autor: "Anónimo" },
  { texto: "La vida comienza al final de tu zona de confort.", autor: "Neale Donald Walsch" },
  { texto: "Si supieran cuánto trabajo puse en mi maestría, no me llamarían genio.", autor: "Michelangelo" },
  { texto: "No hay fracaso excepto en no intentarlo.", autor: "Elbert Hubbard" },
  { texto: "Sé el héroe de tu propia historia.", autor: "Anónimo" },
  { texto: "Los grandes espíritus siempre encuentran violenta oposición de mentes mediocres.", autor: "Albert Einstein" },
  { texto: "Cuanto más disciplina tenés, más libre sos.", autor: "Anónimo" },
  { texto: "Despertarte cansado es mejor que irte a dormir con remordimiento.", autor: "Anónimo" },
  { texto: "Toda habilidad que tenés hoy fue imposible antes de aprenderla.", autor: "Anónimo" },
  { texto: "El dolor de la disciplina es mejor que el dolor del arrepentimiento.", autor: "Anónimo" },
  { texto: "No te compares con nadie. La única comparación válida es con quien eras ayer.", autor: "Anónimo" },
  { texto: "Las raíces de la educación son amargas, pero sus frutos son dulces.", autor: "Aristóteles" },
  { texto: "La vida te pone obstáculos para ver si querés llegar de verdad.", autor: "Anónimo" },
  { texto: "Hacé que cada día valga la pena de haber sido vivido.", autor: "Anónimo" },
  { texto: "La disciplina es el puente entre las metas y los logros.", autor: "Jim Rohn" },
  { texto: "Si no puedes hacer grandes cosas, haz cosas pequeñas de una manera grande.", autor: "Napoleon Hill" },
  { texto: "La mejor forma de predecir el futuro es creándolo.", autor: "Peter Drucker" },
  { texto: "El fracaso es simplemente la oportunidad de comenzar de nuevo, esta vez de forma más inteligente.", autor: "Henry Ford" },
  { texto: "No dejes que lo que no puedes hacer interfiera con lo que puedes hacer.", autor: "John Wooden" },
  { texto: "El riesgo más grande es no tomar ninguno.", autor: "Mark Zuckerberg" },
  { texto: "Si quieres ir rápido, ve solo. Si quieres ir lejos, ve acompañado.", autor: "Proverbio africano" },
  { texto: "Tu actitud determina tu dirección.", autor: "Anónimo" },
  { texto: "Lo que haces hoy puede mejorar todos tus mañanas.", autor: "Ralph Marston" },
  { texto: "Los desafíos son los que hacen que la vida sea interesante.", autor: "Joshua J. Marine" },
  { texto: "No encuentres fallas, encuentra un remedio.", autor: "Henry Ford" },
  { texto: "La suerte es lo que sucede cuando la preparación se encuentra con la oportunidad.", autor: "Séneca" },
  { texto: "La energía y la persistencia conquistan todas las cosas.", autor: "Benjamin Franklin" },
  { texto: "No esperes; el tiempo nunca será justo.", autor: "Napoleon Hill" },
  { texto: "Si quieres alcanzar la grandeza, deja de pedir permiso.", autor: "Anónimo" },
  { texto: "Confía en ti mismo. Sabes más de lo que crees que sabes.", autor: "Benjamin Spock" },
  { texto: "El conocimiento es poder. La información es libertadora.", autor: "Kofi Annan" },
  { texto: "Nada grande se ha logrado sin entusiasmo.", autor: "Ralph Waldo Emerson" },
  { texto: "El éxito es la capacidad de ir de fracaso en fracaso sin perder el entusiasmo.", autor: "Winston Churchill" },
  { texto: "Tanto si piensas que puedes como si piensas que no puedes, estás en lo cierto.", autor: "Henry Ford" },
  { texto: "La mejor venganza es el éxito masivo.", autor: "Frank Sinatra" },
  { texto: "La diferencia entre una persona exitosa y los demás no es la falta de fuerza, sino la falta de voluntad.", autor: "Vince Lombardi" },
  { texto: "El hombre que mueve una montaña comienza cargando pequeñas piedras.", autor: "Confucio" },
  { texto: "El aprendizaje nunca agota la mente.", autor: "Leonardo da Vinci" },
  { texto: "Cada artista fue primero un aficionado.", autor: "Ralph Waldo Emerson" },
  { texto: "Haz de cada día tu obra maestra.", autor: "John Wooden" },
  { texto: "Tu pasión está esperando a que tu valor la alcance.", autor: "Isabelle Lafleche" },
  { texto: "Las dificultades a menudo preparan a la gente común para un destino extraordinario.", autor: "C.S. Lewis" },
  { texto: "Cree que puedes y ya habrás recorrido la mitad del camino.", autor: "Theodore Roosevelt" },
  { texto: "Para ser el mejor, tienes que ser capaz de manejar lo peor.", autor: "Anónimo" },
  { texto: "Si no te equivocas de vez en cuando, es que no lo estás intentando.", autor: "Woody Allen" },
  { texto: "Aquel que tiene fe en sí mismo no necesita que los demás crean en él.", autor: "Miguel de Unamuno" },
  { texto: "No hay nada como volver a un lugar que permanece sin cambios para encontrar las formas en que tú mismo has alterado.", autor: "Nelson Mandela" },
  { texto: "En la vida no se trata de encontrarse a uno mismo, se trata de crearse a uno mismo.", autor: "George Bernard Shaw" },
  { texto: "Un hombre que se atreve a desperdiciar una hora de su tiempo no ha descubierto el valor de la vida.", autor: "Charles Darwin" },
  { texto: "Haz lo que amas y no trabajarás un solo día de tu vida.", autor: "Confucio" },
  { texto: "La calidad no es un acto, es un hábito.", autor: "Aristóteles" },
  { texto: "Solo aquellos que se arriesgan a ir demasiado lejos pueden descubrir hasta dónde se puede llegar.", autor: "T.S. Eliot" },
  { texto: "Nuestra mayor gloria no es no caer nunca, sino levantarnos cada vez que caemos.", autor: "Confucio" },
  { texto: "El éxito consiste en obtener lo que se desea. La felicidad en disfrutar lo que se obtiene.", autor: "Ralph Waldo Emerson" },
  { texto: "Empieza donde estás, usa lo que tienes, haz lo que puedes.", autor: "Arthur Ashe" },
  { texto: "La excelencia es el resultado gradual de siempre querer hacerlo mejor.", autor: "Pat Riley" },
  { texto: "No permitas que nadie te diga que no puedes hacer algo.", autor: "Will Smith (En busca de la felicidad)" },
  { texto: "Si hiciéramos todas las cosas de las que somos capaces, literalmente nos asombraríamos.", autor: "Thomas Edison" },
  { texto: "Quien no arriesga nada, no hace nada, no tiene nada, no es nada.", autor: "Leo Buscaglia" },
  { texto: "No se trata de si te derriban, se trata de si te levantas.", autor: "Vince Lombardi" },
  { texto: "La mente lo es todo. En lo que piensas te conviertes.", autor: "Buda" },
  { texto: "El hombre que no tiene imaginación no tiene alas.", autor: "Muhammad Ali" },
  { texto: "La vida es una aventura atrevida o nada en absoluto.", autor: "Helen Keller" },
  { texto: "El primer paso para el éxito se da cuando te niegas a ser cautivo del entorno en el que te encuentras.", autor: "Mark Caine" },
];

function getRandomSpanishPhrase() {
  return frasesES[Math.floor(Math.random() * frasesES.length)];
}

module.exports = { getPhrase, getRandomSpanishPhrase, getPhraseInstant, iniciarPool };