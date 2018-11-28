module Main where

import Prelude
import Data.Maybe (maybe)
import Effect (Effect)
import Effect.Exception (throw)
import React.Basic.DOM (render)
import Web.DOM.NonElementParentNode (getElementById)
import Web.HTML (window)
import Web.HTML.Window (document)
import Web.HTML.HTMLDocument (toNonElementParentNode)

import Components.App (app)

main :: Effect Unit
main = do
  app' <- app
  window >>= document >>=
  toNonElementParentNode >>> getElementById "root" >>=
  maybe (throw "Root element not found.") (render app')
