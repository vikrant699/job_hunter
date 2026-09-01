// Ported verbatim from D:\Random Code\autoclickInstahyre\instahyre\constants.js (proven-working selectors).
export const INSTAHYRE_URL = "https://www.instahyre.com/candidate/opportunities/?matching=true";

export const SELECTORS = {
  email: "#email",
  password: "#password",
  loginSubmit: "#login-form > button",
  interestedBtn: "#interested-btn",
  applyButton:
    "#candidate-suggested-employers > div > div:nth-child(3) > div > div > div.application-modal-wrap > div.container > div.row.bar-actions.ng-scope > div.apply.ng-scope > button",
  overlayConfirmButton:
    "body > div.application-modal.candidate-apply-all-modal.ng-scope > div > div.application-modal-wrap > div.content.text-center.top-margin > div > div.col-sm-4.col-xs-6.col-sm-offset-2 > button",
} as const;
