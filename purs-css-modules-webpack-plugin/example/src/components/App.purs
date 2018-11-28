module Components.App where

import Prelude
import Effect (Effect)
import React.Basic (Component, JSX, createComponent, makeStateless)
import React.Basic.DOM as DOM

import Components.App.CSS (importCSSModule)

component :: Component Unit
component = createComponent "App"

app :: Effect JSX
app = importCSSModule <#> \{ title } ->
  unit # makeStateless component \_ ->
    DOM.h1 { className: title
           , children: [DOM.text "Hello world"] }
