// Colour correction: exposure, white balance, contrast, saturation, vibrance, lift / gamma / gain, colour filter.
Shader "Hidden/KeyframeStudio/Grade"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
    }
    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "KfCommon.cginc"

            float4 _KfGrade;   // x exposure (stops), y contrast (1 = none), z saturation (1 = none), w vibrance (0 = none)
            float4 _KfBalance; // x temperature (-1..1), y tint (-1..1), z brightness (-1..1), w amount of the whole grade (0..1)
            float4 _KfFilter;  // rgb multiply
            float4 _KfLift;    // rgb shadows offset
            float4 _KfGamma;   // rgb midtones (1 = none)
            float4 _KfGain;    // rgb highlights (1 = none)

            fixed4 frag(v2f i) : SV_Target
            {
                fixed4 src = tex2D(_MainTex, i.uv);
                float3 c = src.rgb;

                c *= exp2(_KfGrade.x);
                // white balance: warm/cool along blue-orange, tint along green-magenta
                c *= float3(1 + 0.1 * _KfBalance.x, 1 - 0.1 * _KfBalance.y, 1 - 0.1 * _KfBalance.x) / (1 + 0.033 * abs(_KfBalance.x));
                c *= _KfFilter.rgb;
                c += _KfBalance.z * 0.25;

                // lift / gamma / gain
                c = c * _KfGain.rgb + _KfLift.rgb * (1 - c);
                c = pow(max(c, 0), 1 / max(_KfGamma.rgb, 0.01));

                c = (c - 0.5) * _KfGrade.y + 0.5;

                float l = Luma(c);
                c = lerp(l.xxx, c, _KfGrade.z);
                // vibrance: more saturation where colours are dull
                float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
                c = lerp(l.xxx, c, 1 + _KfGrade.w * (1 - sat));

                return fixed4(lerp(src.rgb, saturate(c), _KfBalance.w), src.a);
            }
            ENDCG
        }
    }
    Fallback Off
}
