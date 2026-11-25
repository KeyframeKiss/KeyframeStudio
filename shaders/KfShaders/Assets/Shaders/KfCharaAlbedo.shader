// Character lights, step 2 (a replacement shader on a camera that sees characters only): each pixel's own colour
// (its texture times its colour, without any lighting) — what a light shining on it brings out.
Shader "Hidden/KeyframeStudio/CharaAlbedo"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
        _Color ("", Color) = (1, 1, 1, 1)
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" }
        Cull Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float4 _MainTex_ST;
            fixed4 _Color;

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
            };

            v2f vert(appdata_base v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = TRANSFORM_TEX(v.texcoord, _MainTex);
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                fixed4 t = tex2D(_MainTex, i.uv);
                return fixed4(t.rgb * _Color.rgb, 1);
            }
            ENDCG
        }
    }
    Fallback Off
}
