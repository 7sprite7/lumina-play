// Terms of use.
//
// The core point, stated up front and repeated where it matters: Lúmina
// Play is a PLAYER. It ships no lists, no channels and no catalogue, and
// every source it plays is one the user typed in. That is both the honest
// description of the product and the position a store listing has to be
// able to stand on.
//
// Bump TERMS_VERSION whenever the text changes in substance: users who
// accepted an older version are asked again (settings.termsAcceptedVersion
// is compared against it on startup).

import type { Language } from "../types";

export const TERMS_VERSION = 1;

export interface TermsSection {
  title: string;
  body: string;
}

const pt: TermsSection[] = [
  {
    title: "1. O que é o Lúmina Play",
    body:
      "O Lúmina Play é um reprodutor de mídia (player). Ele apenas reproduz listas e " +
      "servidores que você mesmo informa — listas M3U ou acessos no padrão Xtream Codes.",
  },
  {
    title: "2. Não fornecemos conteúdo",
    body:
      "O Lúmina Play não fornece, hospeda, distribui, vende nem indica canais, filmes, " +
      "séries ou listas de reprodução. O aplicativo não vem com nenhuma lista ou servidor " +
      "pré-configurado. Todo o conteúdo exibido vem inteiramente das fontes adicionadas por você.",
  },
  {
    title: "3. Sua responsabilidade",
    body:
      "Você é o único responsável pelas fontes que adiciona e pelo conteúdo que acessa por " +
      "meio delas. Ao usar o aplicativo, você declara ter autorização legal para acessar esse " +
      "conteúdo e se compromete a respeitar os direitos autorais e as leis do seu país.",
  },
  {
    title: "4. Sem vínculo com provedores",
    body:
      "Não temos qualquer relação com os provedores das listas e servidores que você utiliza, " +
      "e não respondemos pela disponibilidade, qualidade, legalidade ou funcionamento deles.",
  },
  {
    title: "5. Seus dados",
    body:
      "Suas listas, credenciais e preferências ficam armazenadas apenas neste dispositivo. " +
      "O aplicativo se conecta diretamente aos servidores que você informa. Os registros de " +
      "diagnóstico também ficam no seu dispositivo e só saem dele se você mesmo exportá-los " +
      "e enviá-los — e, ao exportar, usuários e senhas das suas listas são removidos.",
  },
  {
    title: "6. Proteção de conteúdo adulto",
    body:
      "O bloqueio por PIN é um recurso de conveniência para ocultar categorias marcadas como " +
      "adultas pelo seu provedor. Ele não substitui a supervisão de um responsável.",
  },
  {
    title: "7. Sem garantias",
    body:
      "O aplicativo é oferecido \"como está\", sem garantias de qualquer tipo. Não nos " +
      "responsabilizamos por danos decorrentes do seu uso.",
  },
  {
    title: "8. Alterações",
    body:
      "Estes termos podem ser atualizados. Quando isso acontecer, o aplicativo pedirá que você " +
      "leia e aceite a nova versão antes de continuar.",
  },
];

const en: TermsSection[] = [
  {
    title: "1. What Lúmina Play is",
    body:
      "Lúmina Play is a media player. It only plays lists and servers that you provide " +
      "yourself — M3U playlists or Xtream Codes logins.",
  },
  {
    title: "2. We provide no content",
    body:
      "Lúmina Play does not provide, host, distribute, sell or recommend channels, movies, " +
      "series or playlists. The app ships with no list or server preconfigured. Everything " +
      "shown comes entirely from the sources you add.",
  },
  {
    title: "3. Your responsibility",
    body:
      "You alone are responsible for the sources you add and the content you access through " +
      "them. By using the app you state that you are legally authorised to access that content " +
      "and agree to respect copyright and the laws of your country.",
  },
  {
    title: "4. No relationship with providers",
    body:
      "We have no relationship with the providers of the lists and servers you use, and are " +
      "not responsible for their availability, quality, legality or operation.",
  },
  {
    title: "5. Your data",
    body:
      "Your lists, credentials and preferences are stored only on this device. The app " +
      "connects directly to the servers you provide. Diagnostic logs also stay on your device " +
      "and only leave it if you export and send them yourself — and exporting strips the " +
      "usernames and passwords of your lists.",
  },
  {
    title: "6. Adult content protection",
    body:
      "The PIN lock is a convenience feature that hides categories your provider marks as " +
      "adult. It does not replace supervision by a responsible adult.",
  },
  {
    title: "7. No warranty",
    body:
      "The app is provided \"as is\", without warranty of any kind. We are not liable for " +
      "damages arising from its use.",
  },
  {
    title: "8. Changes",
    body:
      "These terms may be updated. When they are, the app will ask you to read and accept " +
      "the new version before continuing.",
  },
];

export function termsFor(language: Language): TermsSection[] {
  return language === "en" ? en : pt;
}

/** One-line reminder shown where sources are added. */
export function sourceDisclaimer(language: Language): string {
  return language === "en"
    ? "Lúmina Play provides no content. Only add lists and servers you are authorised to use."
    : "O Lúmina Play não fornece conteúdo. Adicione apenas listas e servidores que você tem autorização para usar.";
}
